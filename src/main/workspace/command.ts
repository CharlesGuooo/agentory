import { resumeCommand } from "../sessions/resume";
import type { AgentId } from "../sessions/types";
import type { WorkspaceEntry } from "./model";

export interface EntryCommand {
  command: string;
  args: string[];
  cwd: string;
  /** 供「未启动」状态展示 —— 用户该看得出点下去会执行什么。 */
  display: string;
}

/**
 * 「继续该目录下最近的会话」。实测于 2026-08-13 的各 agent --help。
 * codex 照例是唯一用子命令的。
 */
const CONTINUE: Record<AgentId, string[]> = {
  claude: ["-c"],
  codex: ["resume", "--last"],
  opencode: ["-c"],
  pi: ["-c"],
  grok: ["-c"],
};

/**
 * 由一条工作集记录生成启动命令。
 *
 * - **知道 id**（从历史恢复进来的）→ 精确恢复那个会话
 * - **不知道 id**（在 agentory 里新建的）→ 继续该目录下最近的会话
 *
 * 后者的代价：若用户在同一目录用 agentory 之外的方式又开过会话，
 * `-c` 会接到那一个。可解释、可接受 —— 比事后扫描反查 id 简单得多。
 */
export function entryCommand(entry: WorkspaceEntry): EntryCommand {
  const base =
    entry.sessionId === null
      ? { command: entry.agent, args: CONTINUE[entry.agent], cwd: entry.cwd }
      : resumeCommand({
          agent: entry.agent,
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          // 目录存不存在由调用方现算（D-W1），不在这里假设
          cwdExists: true,
        });
  return { ...base, display: [base.command, ...base.args].join(" ") };
}
