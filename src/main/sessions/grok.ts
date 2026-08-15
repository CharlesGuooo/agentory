import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeSession } from "./scan";
import type { ScanResult, Session } from "./types";

export const defaultGrokRoot = (): string => join(homedir(), ".grok", "sessions");

interface GrokSummary {
  info?: { id?: string; cwd?: string };
  updated_at?: string;
  created_at?: string;
  /** 实测只是首条消息的粗暴截断（从句中切断、带 BOM）—— **不采纳为标题** */
  session_summary?: string;
}

/**
 * Grok 的**一个会话是一个目录**，不是一个文件：
 *
 * ```
 * ~/.grok/sessions/<URL编码的绝对路径>/<uuid>/
 *     summary.json        ← info.cwd / updated_at / num_messages
 *     chat_history.jsonl  ← 消息
 *     events.jsonl  updates.jsonl  system_prompt.txt  *.lock
 * ```
 *
 * 顶层目录名是 URL 编码（无损，可反解），但仍**以 `summary.json` 里的 `info.cwd` 为准** ——
 * 规格要求真实 cwd 一律取自内容。
 *
 * 最后活动时间取 `summary.json` 的 `updated_at`：那是 agent 自己写的，比目录 mtime 可信，
 * 而且这个文件本来就要读。
 */
export function scanGrok(root: string = defaultGrokRoot()): ScanResult {
  if (!existsSync(root)) return { sessions: [], problems: [] };

  const sessions: Session[] = [];
  const problems: string[] = [];

  for (const projectDir of readdirSync(root)) {
    const projectPath = join(root, projectDir);
    if (!statSync(projectPath).isDirectory()) continue;

    for (const sessionDir of readdirSync(projectPath)) {
      const dir = join(projectPath, sessionDir);
      if (!statSync(dir).isDirectory()) continue;

      const summaryPath = join(dir, "summary.json");
      try {
        if (!existsSync(summaryPath)) {
          problems.push(`${sessionDir} 缺 summary.json`);
          continue;
        }
        const sum = JSON.parse(readFileSync(summaryPath, "utf8")) as GrokSummary;
        const cwd = sum.info?.cwd ?? null;

        const stamp = sum.updated_at ?? sum.created_at;
        const parsed = stamp ? new Date(stamp) : null;
        const exact = parsed !== null && !Number.isNaN(parsed.getTime());

        sessions.push(
          makeSession({
            agent: "grok",
            sessionId: sum.info?.id ?? sessionDir,
            cwd,
            lastActivity: exact ? parsed : statSync(dir).mtime,
            lastActivityExact: exact,
            source: dir,
            // 刻意不设 nativeTitle —— session_summary 是粗暴截断，不可用
          }),
        );
      } catch (e) {
        problems.push(`${sessionDir}/summary.json 解析失败：${(e as Error).message}`);
      }
    }
  }

  return { sessions, problems };
}
