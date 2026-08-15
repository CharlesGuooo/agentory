import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALL_AGENTS, type AgentId } from "../sessions/types";
import type { HarnessSource, Scope, SkillEntry } from "./types";

/**
 * skills 的读取。
 *
 * ## 为什么这里只有**一个**实现，而 MCP 有四个
 *
 * 因为 skills 真的是同一件事：Anthropic 2025-12-18 发布 Agent Skills 规范，
 * 48 小时内 VS Code / ChatGPT / Codex CLI 全部接入，到 2026-06 约 40 个产品
 * 读**同一份 `SKILL.md`**。五个 agent 的 skill 目录结构字面上完全相同，
 * 所以抽成一个函数不是投机抽象，是事实。
 *
 * MCP 那边是四套字段名、两种文件格式，所以留四个具体函数（D-11）。
 * **不对称本身就是答案**：代码一样的地方抽，不一样的地方不抽。让证据决定，不让对称性决定。
 *
 * ## skill 的定义
 *
 * **含 `SKILL.md` 的目录。** 不是「skills 目录下的条目」——
 * 实测 `ls | wc -l` 给 40/40/21/40/3，而真正的 skill 是 38/38/18/38/3，
 * 多出来的是 `catalog.json`、`skill-rules.json`、`README.md`、`archived/`。
 * 这条定义可以用 `existsSync` 验证，不需要解析任何东西。
 */

/**
 * 一个目录是不是 skill —— **唯一的判据**，读取、装、卸都用它。
 * 写两遍就有两次分叉的机会。
 */
export const isSkillDir = (p: string): boolean => existsSync(join(p, "SKILL.md"));

/** 每个 agent 的全局 skills 目录。 */
const GLOBAL_ROOTS: Record<AgentId, string> = {
  claude: join(homedir(), ".claude", "skills"),
  codex: join(homedir(), ".codex", "skills"),
  opencode: join(homedir(), ".config", "opencode", "skills"),
  pi: join(homedir(), ".pi", "agent", "skills"),
  grok: join(homedir(), ".grok", "skills"),
};

/** 每个 agent 的项目级 skills 目录，相对于项目根。 */
const PROJECT_SUBDIRS: Record<AgentId, string[]> = {
  claude: [".claude", "skills"],
  codex: [".codex", "skills"],
  opencode: [".opencode", "skills"],
  pi: [".pi", "skills"],
  grok: [".grok", "skills"],
};

/** 某个 agent 在某个作用域下的 skills 目录。 */
export function skillsRoot(agent: AgentId, scope: Scope): string {
  if (scope.kind === "global") return GLOBAL_ROOTS[agent];
  return join(scope.cwd, ...PROJECT_SUBDIRS[agent]);
}

export interface SkillsResult {
  entries: SkillEntry[];
  state: HarnessSource["state"];
}

/**
 * 列出一个目录下的 skill。
 *
 * 目录不存在 = `missing`（没装 / 没配过，不是错误）；
 * 读不动 = `unreadable`（**绝不当成 0 条**）。
 */
export function readSkills(root: string): SkillsResult {
  if (!existsSync(root)) return { entries: [], state: "missing" };
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { entries: [], state: "unreadable" };
  }

  const entries: SkillEntry[] = [];
  for (const name of names) {
    const path = join(root, name);
    // 就是这一句让 40 变成 38：catalog.json / README.md 不是目录，
    // 而 archived/ 是目录但里面没有 SKILL.md
    if (isSkillDir(path)) entries.push({ name, path });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, state: entries.length === 0 ? "empty" : "ok" };
}

/** 某个作用域下，所有 agent 的 skills 根 —— 卸载时用它做「路径必须在已知根里」的白名单。 */
export const allSkillRoots = (scope: Scope): string[] =>
  ALL_AGENTS.map((a) => skillsRoot(a, scope));
