import type { AgentId, Session } from "./types";

export interface ResumeCommand {
  /** agent 名。启动前由 terminal-host 的 resolveCommand 解析成真实可执行文件。 */
  command: string;
  args: string[];
  /** 必须是会话自己的真实工作目录 —— agent 的会话按目录划分。 */
  cwd: string;
}

/**
 * 五套恢复命令，实测于 2026-08-13。
 *
 * **两条不能踩的线：**
 *
 * 1. **codex 是唯一用子命令的**（`codex resume <id>`，不是 `--resume`）。
 *    这是 `README.md §8` 定下的验收标准。
 * 2. **绝不用 `--session-id`**。`pi` 和 `grok` 都有这个参数，但它的语义是
 *    「用这个 id，不存在就**创建**」—— 拿它恢复，id 对不上时不报错，
 *    而是静默开一个新的空会话。用户以为历史回来了，实际什么都没有。
 *    静默失败比报错危险得多。
 *
 * `README.md §3.3` 对 grok 记的是 `--session-id`，那是错的，已在本次修正。
 */
const RECIPES: Record<AgentId, (id: string) => string[]> = {
  claude: (id) => ["--resume", id],
  // 子命令，不是 flag
  codex: (id) => ["resume", id],
  opencode: (id) => ["--session", id],
  // 不是 --session-id
  pi: (id) => ["--session", id],
  // 不是 --session-id
  grok: (id) => ["--resume", id],
};

/**
 * 由一条索引记录生成恢复命令。
 *
 * 工作目录不可用时**抛错而不是回退** —— 在错的目录下恢复，
 * 轻则找不到会话，重则在别的项目里开出一个新会话。
 * 一条明确的错误消息，比一个"看起来成功了"的空会话有用得多。
 */
/** 只要这四样。收窄到最小集，调用方就不必为了满足类型现编 `lastActivity` 之类的假数据。 */
export type Resumable = Pick<Session, "agent" | "sessionId" | "cwd" | "cwdExists">;

export function resumeCommand(session: Resumable): ResumeCommand {
  if (session.cwd === null) {
    throw new Error(
      `无法恢复 ${session.agent} 会话 ${session.sessionId}：它的工作目录未知（会话文件里读不到）`,
    );
  }
  if (!session.cwdExists) {
    throw new Error(
      `无法恢复 ${session.agent} 会话 ${session.sessionId}：工作目录已不存在 —— ${session.cwd}`,
    );
  }
  return {
    command: session.agent,
    args: RECIPES[session.agent](session.sessionId),
    cwd: session.cwd,
  };
}
