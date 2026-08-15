import { existsSync, statSync } from "node:fs";
import type { AgentId, Session } from "./types";

/** 本产品支持的五个 agent，顺序固定 —— 界面上的排列不该每次刷新都变。 */
const ALL_AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

/**
 * 本机真正可用的 agent。
 *
 * 解析器由调用方传入，且**必须是启动时用的同一个**（`terminal-host` 的 `resolveCommand`）——
 * 两套判定迟早会分叉，那时列表里就会出现"选了才发现启动不了"的项，
 * 又是一个界面上的假承诺。
 */
export function availableAgents(resolve: (name: string) => unknown): AgentId[] {
  return ALL_AGENTS.filter((a) => {
    try {
      resolve(a);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * 从会话索引里取工作目录候选，去重并按该目录上最近一次活动倒序。
 *
 * **排除 `cwdExists=false` 的会话** —— 这与历史视图刻意不同：
 * 历史视图保留它们（那是回顾，用户的历史不该被藏起来），
 * 而候选是要拿去启动的，给一个不存在的目录毫无意义。
 */
export function folderSuggestions(sessions: Session[]): string[] {
  const newest = new Map<string, number>();
  for (const s of sessions) {
    if (s.cwd === null || !s.cwdExists) continue;
    const t = s.lastActivity.getTime();
    if (t > (newest.get(s.cwd) ?? -Infinity)) newest.set(s.cwd, t);
  }
  return [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([dir]) => dir);
}

/**
 * 校验新建会话的目标目录。
 *
 * **不存在就报错，绝不自动创建** —— 手输路径打错字是常态，
 * 悄悄 `mkdir` 然后在里面开一个空会话，用户会以为自己进错了项目。
 */
export function validateTarget(dir: string): void {
  if (!dir.trim()) throw new Error("请先选择工作目录");
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  if (!statSync(dir).isDirectory()) throw new Error(`这个路径不是目录：${dir}`);
}
