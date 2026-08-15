import type { AgentId, Session } from "./types";

export interface SessionFilter {
  /** 匹配工作目录或原生标题，忽略大小写。全空白视同没有条件。 */
  text?: string;
  /** 空数组或不传 = 不限制 agent。 */
  agents?: AgentId[];
}

/**
 * 筛选已索引的会话。
 *
 * **保持输入顺序不变** —— 输入应当是 `scanAll` 的输出（已按最后活动时间倒序），
 * 这里只做过滤，不重新排序，也就不会有"筛完顺序变了"的意外。
 */
export function filterSessions(sessions: Session[], f: SessionFilter): Session[] {
  const text = f.text?.trim().toLowerCase() ?? "";
  const agents = f.agents && f.agents.length > 0 ? new Set(f.agents) : null;

  return sessions.filter((s) => {
    if (agents && !agents.has(s.agent)) return false;
    if (!text) return true;
    // cwd 可能是 null（读不到工作目录的会话），不能直接 toLowerCase
    const hay = `${s.cwd ?? ""}\n${s.nativeTitle ?? ""}`.toLowerCase();
    return hay.includes(text);
  });
}
