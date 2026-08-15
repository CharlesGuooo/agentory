export type AgentId = "claude" | "codex" | "opencode" | "pi" | "grok";

/**
 * 五个 agent，顺序固定 —— 界面上的排列不该每次刷新都变。
 *
 * 放在这个纯类型文件里是因为它零 import，渲染层可以安全地拿（不会被连带拉进 `node:fs`）。
 * 仓库里另有 6 处同样的字面量（`favorites/store.ts`、`workspace/store.ts`、
 * `summary/cache.ts`、`agents/installed.ts`、`sessions/launch.ts`、`renderer/shell.ts`），
 * 那些不属于这一刀的范围，改动时可以逐步换过来。
 */
export const ALL_AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

/**
 * 一个会话在索引里的样子。
 *
 * 三条来自实测的硬约束（见 openspec 的 `session-index` 规格）：
 * 1. `cwd` 必须取自会话内容，绝不反解存储目录名 —— Claude 与 Pi 的目录名是有损编码
 * 2. 取不到就是 `null`，不是空串、更不是拼出来的路径
 * 3. `lastActivity` 取自内容里的时间戳，不用文件 mtime —— 两者实测能差 8 天
 */
export interface Session {
  agent: AgentId;
  /** agent 自己的会话 id，恢复时要用 */
  sessionId: string;
  /** 真实工作目录。取不到时为 null。 */
  cwd: string | null;
  /** 该目录此刻是否存在。`cwd` 为 null 时恒为 false。 */
  cwdExists: boolean;
  lastActivity: Date;
  /** false 表示没能从内容里取到时间戳、退回用了文件 mtime，该时间不可全信 */
  lastActivityExact: boolean;
  /** agent 自带且**质量可用**的标题。目前只有 OpenCode 有 —— Grok 的是粗暴截断，不采纳。 */
  nativeTitle?: string;
  /**
   * 会话开头那句有信息量的用户消息，截断后的。取不到就没有这个字段。
   *
   * 这是真摘要（D-7）做出来之前的**占位**。界面上第二行走优先级链：
   * 摘要 ?? nativeTitle ?? preview。
   */
  preview?: string;
  /** 会话在磁盘上的位置（文件或目录），后续读 transcript 用 */
  source: string;
}

export interface ScanResult {
  sessions: Session[];
  /** 被跳过的条目及原因。调用方负责展示 —— 不静默丢弃。 */
  problems: string[];
}
