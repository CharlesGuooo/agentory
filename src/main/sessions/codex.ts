import { existsSync, readdirSync, statSync } from "node:fs";
import { agentPaths } from "../paths";
import { join } from "node:path";
import { HEAD_LINES, findJsonString, lastActivityOf } from "./jsonl";
import { makeSession } from "./scan";
import type { ScanResult, Session } from "./types";

export const defaultCodexRoot = (): string => join(agentPaths().codex.home.path, "sessions");

/** 递归收集 `YYYY/MM/DD/` 下的会话文件。层级本身不带任何项目信息。 */
function collect(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (name.toLowerCase().endsWith(".jsonl")) out.push(p);
  }
}

/**
 * Codex **按日期分区**：`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`。
 *
 * 路径里完全没有项目信息 —— 工作目录只能从内容里取，而且
 * **它在 `turn_context` 记录里，不在 `session_meta` 里**（实测）。
 */
export function scanCodex(root: string = defaultCodexRoot()): ScanResult {
  if (!existsSync(root)) return { sessions: [], problems: [] };

  const files: string[] = [];
  collect(root, files);

  const sessions: Session[] = [];
  const problems: string[] = [];

  for (const file of files) {
    const name = file.slice(root.length + 1);
    try {
      // session_id 在第一行的 session_meta.payload 里；读不到就退回文件名里的那段
      const id =
        findJsonString(file, 5, "session_id") ??
        name.replace(/^.*rollout-[\d-T]+-/, "").replace(/\.jsonl$/i, "");
      const cwd = findJsonString(file, HEAD_LINES, "cwd");
      const act = lastActivityOf(file);
      sessions.push(
        makeSession({
          agent: "codex",
          sessionId: id,
          cwd,
          lastActivity: act.at,
          lastActivityExact: act.exact,
          source: file,
        }),
      );
    } catch (e) {
      problems.push(`${name} 解析失败：${(e as Error).message}`);
    }
  }

  return { sessions, problems };
}
