import { t } from "../../shared/i18n";
import { existsSync, readdirSync, statSync } from "node:fs";
import { agentPaths } from "../paths";
import { join } from "node:path";
import { HEAD_LINES, findJsonString, lastActivityOf, readHead } from "./jsonl";
import { makeSession } from "./scan";
import type { ScanResult, Session } from "./types";

export const defaultClaudeRoot = (): string => join(agentPaths().claude.configDir.path, "projects");

/**
 * Claude 的存储：
 *
 * ```
 * ~/.claude/projects/<编码目录>/
 *     <uuid>.jsonl      ← 真正的会话
 *     <uuid>/           ← 该会话的附属目录，**不是会话**
 *         subagents/agent-*.jsonl   ← 子 agent，带 "isSidechain": true
 *         tool-results/  workflows/
 *     memory/
 * ```
 *
 * **只取顶层的 `<uuid>.jsonl`，绝不递归** —— 递归会把 74 个真会话数成 459 个（实测）。
 *
 * 目录名是**有损编码**（`\` 和 `_` 都变成 `-`），所以 `local_GPU` 存成 `local-GPU`，
 * 反解必然得到不存在的路径。真实 cwd 一律从文件内容里取。
 */
export function scanClaude(root: string = defaultClaudeRoot()): ScanResult {
  if (!existsSync(root)) return { sessions: [], problems: [] };

  const sessions: Session[] = [];
  const problems: string[] = [];

  for (const projectDir of readdirSync(root)) {
    const dirPath = join(root, projectDir);
    if (!statSync(dirPath).isDirectory()) continue;

    for (const name of readdirSync(dirPath)) {
      if (!name.toLowerCase().endsWith(".jsonl")) continue;
      const file = join(dirPath, name);
      // readdir 不递归，所以子目录里的 agent-*.jsonl 天然不会进来。
      // 这里再拦一道：真的是文件才算。
      if (!statSync(file).isFile()) continue;

      try {
        // 侧链标记 = 子 agent 的 transcript。顶层不该出现，但规格要求识别它。
        const head = readHead(file, 3).lines.join("\n");
        if (/"isSidechain"\s*:\s*true/.test(head)) {
          problems.push(t("scan.sidechain", { name }));
          continue;
        }

        const cwd = findJsonString(file, HEAD_LINES, "cwd");
        const act = lastActivityOf(file);
        sessions.push(
          makeSession({
            agent: "claude",
            sessionId: name.replace(/\.jsonl$/i, ""),
            cwd,
            lastActivity: act.at,
            lastActivityExact: act.exact,
            source: file,
          }),
        );
      } catch (e) {
        problems.push(t("scan.parseFailed", { name, msg: (e as Error).message }));
      }
    }
  }

  return { sessions, problems };
}
