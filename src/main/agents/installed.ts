import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCommand, type ResolvedCommand } from "../terminal/resolve";
import type { AgentId } from "../sessions/types";

/**
 * 本机装了哪些 agent、各是什么版本。
 *
 * ## 为什么不跑 `<agent> --version`
 *
 * 因为**根本不用起进程**：四个 agent 走 npm，版本就写在它们自己的 `package.json` 里；
 * grok 是独立二进制，版本写在它自带的 `CHANGELOG.md` 首行。全部是文件读，毫秒级。
 *
 * 而「不起 agent 进程」不只是快 —— 这个项目最贵的一次事故就是探针碰了 agent 的 TUI：
 * `/help` + 回车在 codex 的升级对话框上选中了「立即更新」，把 codex 卸掉重装
 * （`openspec/changes/prototype-terminal-fidelity/findings.md:130-137`）。
 * grok 的二进制里同样有 `Update now? [Y/n/d]`，是同一类地雷。
 * 能用读文件回答的问题，就不要用起进程去问。
 */

/** 往上走几层就放弃。够覆盖 `<pkg>/bin/x.exe` 和 `<pkg>/dist/cli.js`，又不会走到磁盘根。 */
const MAX_UP = 6;

/** 从 `start` 所在目录往上逐层找，命中就返回。 */
function walkUp<T>(start: string, probe: (dir: string) => T | null): T | null {
  let dir = dirname(start);
  for (let i = 0; i < MAX_UP; i++) {
    const hit = probe(dir);
    if (hit !== null) return hit;
    const up = dirname(dir);
    if (up === dir) break; // 到根了
    dir = up;
  }
  return null;
}

export interface PackageInfo {
  name: string | null;
  version: string;
}

/**
 * 从可执行文件往上找到的**第一个**带 `version` 的 `package.json`。
 *
 * 「第一个」很重要：外层往往还有别的 `package.json`（比如 npm 自己的），
 * 拿错了就会显示成完全不相干的版本号。
 */
export function packageJsonUp(exePath: string): PackageInfo | null {
  return walkUp(exePath, (dir) => {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return null;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { name?: unknown; version?: unknown };
      if (typeof j.version !== "string" || !j.version) return null;
      return { name: typeof j.name === "string" ? j.name : null, version: j.version };
    } catch {
      // 坏 JSON 不该让整个版本检测失败 —— 当成没找到，继续往上
      return null;
    }
  });
}

/** CHANGELOG 首行形如 `# 0.2.118 — 2026-07-31`，取出版本那一段。 */
const CHANGELOG_HEAD = /^#\s*v?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?)\b/;

/**
 * 从可执行文件往上找 `CHANGELOG.md`，读首行的版本号。
 *
 * 这是给 grok 这类**不走包管理器**的独立二进制用的。
 * 本机交叉验证过：`~/.grok/CHANGELOG.md` 首行是 `# 0.2.118`，
 * 而 `grok.exe` 里紧挨着 `currentVersion` 的字面量也是 `0.2.118 (1e1687c1cf)`，两处一致。
 */
export function changelogUp(exePath: string): string | null {
  return walkUp(exePath, (dir) => {
    const p = join(dir, "CHANGELOG.md");
    if (!existsSync(p)) return null;
    try {
      // 只读开头一小段，changelog 可能很长
      const head = readFileSync(p, "utf8").slice(0, 200).split(/\r?\n/, 1)[0] ?? "";
      return CHANGELOG_HEAD.exec(head)?.[1] ?? null;
    } catch {
      return null;
    }
  });
}

export interface Installed {
  agent: AgentId;
  /** 读不出来就是 null —— 界面显示「版本未知」，**不猜**。 */
  version: string | null;
  /** npm 包名。更新命令要用它，所以不写死。非 npm 装的就是 null。 */
  pkg: string | null;
  /** 版本是从哪读出来的。出问题时定位用。 */
  from: string;
}

const ALL: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

/**
 * 一个 agent 的版本。
 *
 * **要看的是 `args[0] ?? exe`**：codex / pi 的 shim 走 node 跑一个 `.js`，
 * 这时 `exe` 是 node 自己，往上走只会找到 node 的目录 —— 真正的包在脚本那一侧。
 */
function versionOf(agent: AgentId, r: ResolvedCommand): Installed {
  const target = r.args[0] ?? r.exe;

  const pkg = packageJsonUp(target);
  if (pkg) return { agent, version: pkg.version, pkg: pkg.name, from: "package.json" };

  const cl = changelogUp(target);
  if (cl) return { agent, version: cl, pkg: null, from: "CHANGELOG.md" };

  return { agent, version: null, pkg: null, from: `读不出：${target}` };
}

/**
 * 本机装了的 agent 及其版本。没装的不出现在结果里。
 *
 * `resolve` 可注入是为了测试；生产上必须是 `resolveCommand` —— 用**同一个解析器**，
 * 两套判定会分叉，那时列表里就会出现「显示装了但启动不了」的项（见 `launch.ts` 的注释）。
 */
export function installedVersions(resolve: (name: string) => ResolvedCommand = resolveCommand): Installed[] {
  const out: Installed[] = [];
  for (const agent of ALL) {
    try {
      out.push(versionOf(agent, resolve(agent)));
    } catch {
      // 解析不出来 = 没装。不是错误。
    }
  }
  return out;
}
