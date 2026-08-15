import type { AgentId } from "../sessions/types";

/**
 * 工作集里的一条记录。
 *
 * **刻意只有四个字段。** 两条来自 D-5 / D-W1 的约束：
 *
 * 1. **没有运行状态** —— 「在不在工作集」与「跑没跑」是两个正交概念。
 *    不是靠约定「记得别改它」，而是结构上就没有可改的东西，
 *    所以「进程退出不改变成员资格」是被类型保证的，不是被纪律保证的。
 * 2. **不缓存索引字段**（`lastActivity` / `nativeTitle` / `cwdExists`）——
 *    它们会过期，而工作集的职责是「记住你在用哪些」，不是「缓存索引」。
 *    要新鲜信息就去扫（339 ms，D-4 已定不建缓存）。
 *
 * 这三样（agent / sessionId / cwd）正好是 `resumeCommand` 需要的全部。
 */
export interface WorkspaceEntry {
  agent: AgentId;
  /**
   * agent 自己的会话 id。
   *
   * **可以是 null** —— 在 agentory 里新建的会话，spawn 那一刻拿不到 id
   * （id 是 agent 自己生成并写进会话文件的）。这类条目靠
   * 「继续该目录下最近的会话」恢复，见 `entryCommand`。
   */
  sessionId: string | null;
  cwd: string;
  /**
   * 会话开头那句话的快照，从历史恢复进来时一并记下。新建的会话没有（还没有内容可读）。
   *
   * 与收藏夹同一个理由（D-F4）：它是不可变数据，不是会过期的索引字段，
   * 存下来换到的是「启动时零文件读」—— 侧栏要在扫描之前就能显示这一行。
   */
  label?: string;
  /** 进入工作集的时间，ISO 字符串。重复加入时保留最早的那次。 */
  addedAt: string;
}

export interface Workspace {
  version: 1;
  sessions: WorkspaceEntry[];
}

export const emptyWorkspace = (): Workspace => ({ version: 1, sessions: [] });

/**
 * 条目的主键。
 *
 * 知道 id 时用 id；不知道时用工作目录 —— 因为「没有 id 的条目」的含义就是
 * 「该目录下最近的那个会话」，所以**同 agent 同目录才是同一条**。
 * 若只按 `(agent, sessionId)` 比，两个都为 null 的条目会被误判成重复，
 * 于是「同一个 agent 在两个目录各新建一个」的第二条会被悄悄丢掉。
 *
 * 分隔符用 `|`：它在 Windows 路径里非法，在 agent id 和 UUID 里也不会出现，
 * 所以不会造成歧义。**刻意不用 U+0000** —— 主键要写进 DOM 属性再读回来查找，
 * 而 HTML 属性解析会把 U+0000 改写成 U+FFFD（实测），让每次查找都静默失配。
 */
const keyOf = (agent: AgentId, sessionId: string | null, cwd: string): string =>
  `${agent}|${sessionId ?? `cwd:${cwd}`}`;

export const hasEntry = (ws: Workspace, agent: AgentId, id: string | null, cwd: string): boolean =>
  ws.sessions.some((e) => entryKey(e) === keyOf(agent, id, cwd));

/**
 * 加入工作集。`(agent, sessionId)` 是主键 —— 重复加入不产生副本，
 * 且**保留最早的 `addedAt`**（它记的是"什么时候进的工作集"，不是"最后一次被点"）。
 */
export function addEntry(ws: Workspace, entry: WorkspaceEntry): Workspace {
  if (hasEntry(ws, entry.agent, entry.sessionId, entry.cwd)) return ws;
  return { ...ws, sessions: [...ws.sessions, entry] };
}

export function removeEntry(
  ws: Workspace,
  agent: AgentId,
  id: string | null,
  cwd: string,
): Workspace {
  const key = keyOf(agent, id, cwd);
  return { ...ws, sessions: ws.sessions.filter((e) => entryKey(e) !== key) };
}

/** 条目在界面上的稳定标识。渲染层用它把工作集条目与终端面板对上。 */
export const entryKey = (e: WorkspaceEntry): string => keyOf(e.agent, e.sessionId, e.cwd);
