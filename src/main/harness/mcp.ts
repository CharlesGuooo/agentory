import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inlineSecretPaths, keysOf, safeUrl, stringsOf } from "./fields";
import { readToml } from "./toml";
import type { McpEntry, McpTarget, SourceState } from "./types";

/**
 * 四个 agent 的 MCP 配置读取。**pi 不在这里** —— 它不支持 MCP
 * （README 明写 `No MCP. Build CLI tools with READMEs (see Skills)`），
 * 那条事实写在 `all.ts` 里，是一条 `unsupported` 记录，不是「从数组里省略」。
 *
 * ## 为什么这里是四个具体函数，不是一个接口
 *
 * 它们真的不一样 —— 两种文件格式、四套字段名：
 *
 * | agent | 文件 | 服务器在哪 | 命令 | 环境变量 | 停用 |
 * |---|---|---|---|---|---|
 * | claude | `~/.claude.json` **和** `~/.claude/settings.json` | `mcpServers` | `command` + `args[]` | `env{}` | — |
 * | codex | `~/.codex/config.toml` | `[mcp_servers.*]` | `command` + `args[]` | `env{}` / `env_vars[]` | `enabled` |
 * | opencode | `~/.config/opencode/opencode.json` | `mcp` | `command[]`（合一） | `environment{}` | `enabled` |
 * | grok | `~/.grok/config.toml` | `[mcp_servers.*]` | `command` + `args[]` | `env{}` | `enabled` |
 *
 * 抽一个「五合一」的配置对象才是假抽象（D-11），而且那个对象会成为秘密进内存的入口。
 * skills 那边只有一个实现，是因为**它们真的一样**。不对称本身就是答案。
 */

export interface McpResult {
  entries: McpEntry[];
  state: SourceState;
  note: string | null;
}

const missing = (): McpResult => ({ entries: [], state: "missing", note: null });
const unreadable = (why: string): McpResult => ({ entries: [], state: "unreadable", note: why });
const done = (entries: McpEntry[]): McpResult => ({
  entries,
  state: entries.length === 0 ? "empty" : "ok",
  note: null,
});

/** 只有配置里**直接写着** `enabled: false` 才是 true；没写是 null（「没说」≠「说了开」）。 */
const disabled = (raw: Record<string, unknown>): boolean | null =>
  raw["enabled"] === false ? true : raw["enabled"] === true ? false : null;

/** `command` + `args[]` 那三家的 argv。 */
function argvOf(raw: Record<string, unknown>): string[] | null {
  const c = raw["command"];
  if (typeof c === "string" && c) return [c, ...stringsOf(raw["args"])];
  // opencode 把命令和参数合成一个数组
  if (Array.isArray(c)) {
    const argv = stringsOf(c);
    return argv.length > 0 ? argv : null;
  }
  return null;
}

/** stdio 还是 http。认不出就说认不出。 */
function targetOf(raw: Record<string, unknown>): McpTarget {
  const url = raw["url"];
  if (typeof url === "string" && url) return { kind: "http", url: safeUrl(url) };
  const argv = argvOf(raw);
  return argv ? { kind: "stdio", argv } : { kind: "unknown" };
}

/**
 * 一条服务器记录 → `McpEntry`。
 *
 * `envKey` 是这个 agent 管环境变量的字段名（claude/codex/grok 叫 `env`，opencode 叫 `environment`）。
 * **只取键名**，值从不绑定到变量 —— 见 `fields.ts` 的说明。
 */
function entryOf(
  name: string,
  raw: Record<string, unknown>,
  source: string,
  envKey: "env" | "environment",
): McpEntry {
  return {
    name,
    target: targetOf(raw),
    disabledInConfig: disabled(raw),
    envNames: [
      ...keysOf(raw[envKey]),
      // codex 的 env_vars 本来就只有名字；bearer_token_env_var 也是
      ...stringsOf(raw["env_vars"]),
      ...(typeof raw["bearer_token_env_var"] === "string" ? [raw["bearer_token_env_var"]] : []),
    ],
    headerNames: keysOf(raw["headers"]),
    inlineSecrets: [
      ...inlineSecretPaths(envKey, raw[envKey]),
      ...inlineSecretPaths("headers", raw["headers"]),
    ],
    source,
  };
}

/** 把 `{ 名字: 配置 }` 这一层展开成条目。 */
function fromMap(map: unknown, source: string, envKey: "env" | "environment"): McpEntry[] {
  if (typeof map !== "object" || map === null) return [];
  return Object.entries(map as Record<string, unknown>)
    .filter((kv): kv is [string, Record<string, unknown>] =>
      typeof kv[1] === "object" && kv[1] !== null && !Array.isArray(kv[1]),
    )
    .map(([name, raw]) => entryOf(name, raw, source, envKey))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * claude 有**两个**来源，所以它返回两条结果。
 *
 * `~/.claude.json` 实测生效（9 个），`~/.claude/settings.json` 里另有 17 个而
 * 实测**一个都没生效**。我们**不合并、不选胜者** —— 合并要求我们知道优先级规则，
 * 而我们无法判定那 17 条是「不被支持」还是「被盖掉」。两份都列出来并标出来源，
 * 用户自己就看得见「我改的那份可能没用」。
 *
 * ⚠️ `~/.claude.json` 实测 178 KB，里面还有 97 个 project 条目（含路径和 allowedTools）。
 * 取完 `mcpServers` 就让其余的被回收，一个字段都不该进我们的结构。
 */
export function claudeMcpSources(): { path: string; result: McpResult }[] {
  return [
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude", "settings.json"),
  ].map((path) => {
    if (!existsSync(path)) return { path, result: missing() };
    const j = readJson(path) as { mcpServers?: unknown } | null;
    if (j === null) return { path, result: unreadable("文件不是合法 JSON") };
    return { path, result: done(fromMap(j.mcpServers, path, "env")) };
  });
}

export const codexMcpPath = (): string => join(homedir(), ".codex", "config.toml");

export function readCodexMcp(path = codexMcpPath()): McpResult {
  if (!existsSync(path)) return missing();
  const t = readToml(path) as { mcp_servers?: unknown } | null;
  if (t === null) return unreadable("TOML 解析失败");
  return done(fromMap(t.mcp_servers, path, "env"));
}

export const openCodeMcpPath = (): string =>
  join(homedir(), ".config", "opencode", "opencode.json");

export function readOpenCodeMcp(path = openCodeMcpPath()): McpResult {
  if (!existsSync(path)) return missing();
  const j = readJson(path) as { mcp?: unknown } | null;
  if (j === null) return unreadable("文件不是合法 JSON");
  // 注意键名是 "mcp" 不是 "mcpServers"，环境变量字段叫 "environment" 不是 "env"
  return done(fromMap(j.mcp, path, "environment"));
}

export const grokMcpPath = (): string => join(homedir(), ".grok", "config.toml");

/**
 * grok 多一层：`[compat.claude] mcps = false` 表达的不是某条服务器停用，
 * 而是**一整个来源被关掉** —— grok 本可以继承 `~/.claude.json` 的那些，
 * 它只显示 1 个是因为自己配置里的那两行。这个事实值钱，不该被丢掉。
 */
export function readGrokMcp(path = grokMcpPath()): McpResult {
  if (!existsSync(path)) return missing();
  const t = readToml(path) as
    | { mcp_servers?: unknown; compat?: Record<string, { mcps?: unknown }> }
    | null;
  if (t === null) return unreadable("TOML 解析失败");

  const off = Object.entries(t.compat ?? {})
    .filter(([, v]) => v?.mcps === false)
    .map(([k]) => k);

  const r = done(fromMap(t.mcp_servers, path, "env"));
  return off.length === 0
    ? r
    : { ...r, note: `配置里 ${off.map((k) => `[compat.${k}] mcps = false`).join("、")}，没有继承那边的 MCP` };
}
