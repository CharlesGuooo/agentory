import { loadEntryFile, saveEntryFile } from "../entryFile";
import type { AgentId } from "../sessions/types";

/**
 * 摘要缓存 —— D-6 说的第二个 JSON 文件，到这一刀才真的建起来。
 *
 * **复用 `entryFile.ts` 的落盘外壳**：它已经有「坏文件绝不写回、单条坏只跳过那条」
 * 的语义和测试。摘要是花过钱的东西，因为一条记录格式不对就把整份缓存清掉，
 * 代价是让用户重新付一次费。
 */

const AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

export interface SummaryEntry {
  agent: AgentId;
  sessionId: string;
  text: string;
  model: string;
  /** 生成时间，ISO。 */
  at: string;
  /**
   * 生成时那条会话的 `lastActivity`。
   *
   * 会话是 append-only 的：之后又聊了几轮，摘要就过期了。存下当时的水位线，
   * 下次批量跑到它时一比就知道要不要重摘。**过期的照常显示** —— 旧摘要也比没有强。
   */
  sourceLastActivity: string;
}

export const summaryKey = (agent: AgentId, sessionId: string): string => `${agent}|${sessionId}`;

function parseEntry(raw: unknown, index: number): SummaryEntry {
  if (typeof raw !== "object" || raw === null) throw new Error(`第 ${index + 1} 条不是对象`);
  const o = raw as Record<string, unknown>;
  const { agent, sessionId, text, model, at, sourceLastActivity } = o;
  if (typeof agent !== "string" || !AGENTS.includes(agent as AgentId)) {
    throw new Error(`第 ${index + 1} 条的 agent 不认识：${JSON.stringify(agent)}`);
  }
  if (typeof sessionId !== "string" || !sessionId) throw new Error(`第 ${index + 1} 条缺 sessionId`);
  if (typeof text !== "string" || !text) throw new Error(`第 ${index + 1} 条缺 text`);
  return {
    agent: agent as AgentId,
    sessionId,
    text,
    model: typeof model === "string" ? model : "",
    at: typeof at === "string" ? at : new Date(0).toISOString(),
    sourceLastActivity:
      typeof sourceLastActivity === "string" ? sourceLastActivity : new Date(0).toISOString(),
  };
}

export interface LoadedSummaries {
  byKey: Map<string, SummaryEntry>;
  warnings: string[];
}

export function loadSummaries(path: string): LoadedSummaries {
  const { entries, warnings } = loadEntryFile(path, parseEntry);
  return {
    byKey: new Map(entries.map((e) => [summaryKey(e.agent, e.sessionId), e])),
    warnings,
  };
}

export function saveSummaries(path: string, byKey: Map<string, SummaryEntry>): void {
  saveEntryFile(path, [...byKey.values()]);
}

/** 会话在摘要之后又动过了吗。 */
export const isStale = (e: SummaryEntry, lastActivity: Date): boolean =>
  lastActivity.getTime() > new Date(e.sourceLastActivity).getTime();
