import { loadEntryFile, saveEntryFile } from "../entryFile";
import type { AgentId } from "../sessions/types";
import type { Workspace, WorkspaceEntry } from "./model";

const AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

export interface LoadResult {
  workspace: Workspace;
  /** 被跳过的条目及原因。调用方负责展示 —— 不静默丢弃用户的记录。 */
  warnings: string[];
}

function parseEntry(raw: unknown, index: number): WorkspaceEntry {
  if (typeof raw !== "object" || raw === null) throw new Error(`第 ${index + 1} 条不是对象`);
  const o = raw as Record<string, unknown>;
  const { agent, sessionId, cwd, addedAt, label } = o;

  if (typeof agent !== "string" || !AGENTS.includes(agent as AgentId)) {
    throw new Error(`第 ${index + 1} 条的 agent 不认识：${JSON.stringify(agent)}`);
  }
  // sessionId 允许为 null —— 新建的会话在 spawn 那一刻还没有 id
  if (sessionId !== null && sessionId !== undefined && typeof sessionId !== "string") {
    throw new Error(`第 ${index + 1} 条的 sessionId 类型不对`);
  }
  if (typeof cwd !== "string" || !cwd) throw new Error(`第 ${index + 1} 条缺 cwd`);

  return {
    agent: agent as AgentId,
    sessionId: typeof sessionId === "string" && sessionId ? sessionId : null,
    cwd,
    ...(typeof label === "string" && label ? { label } : {}),
    addedAt: typeof addedAt === "string" ? addedAt : new Date(0).toISOString(),
  };
}

/** 读工作集。失败语义（坏文件绝不写回、单条坏只跳过那条）在 `entryFile.ts` 里，两个文件共用。 */
export function loadWorkspace(path: string): LoadResult {
  const { entries, warnings } = loadEntryFile(path, parseEntry);
  return { workspace: { version: 1, sessions: entries }, warnings };
}

export function saveWorkspace(path: string, ws: Workspace): void {
  saveEntryFile(path, ws.sessions);
}
