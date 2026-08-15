import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lastActivityOf, readHead } from "./jsonl";
import { makeSession } from "./scan";
import type { ScanResult, Session } from "./types";

export const defaultPiRoot = (): string => join(homedir(), ".pi", "agent", "sessions");

interface PiHeader {
  type?: string;
  id?: string;
  cwd?: string;
}

/**
 * Pi 的会话是 `<编码目录>/<ISO时间戳>_<uuid>.jsonl`，
 * **第一行就是 header，直接带 `cwd` 和 `id`** —— 五个里第二简单的。
 *
 * 目录名同样是有损编码（`:`→`--`，`\`→`-`，首尾包 `--`），一律不反解。
 */
export function scanPi(root: string = defaultPiRoot()): ScanResult {
  if (!existsSync(root)) return { sessions: [], problems: [] };

  const sessions: Session[] = [];
  const problems: string[] = [];

  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    if (!statSync(dirPath).isDirectory()) continue;

    for (const name of readdirSync(dirPath)) {
      if (!name.toLowerCase().endsWith(".jsonl")) continue;
      const file = join(dirPath, name);
      try {
        const first = readHead(file, 1).lines[0];
        if (!first) {
          problems.push(`${name} 是空文件`);
          continue;
        }
        // 第一行很小，直接 JSON.parse —— 比正则加手工反转义可靠
        const header = JSON.parse(first) as PiHeader;
        if (header.type !== "session") {
          problems.push(`${name} 第一行不是 session header（type=${String(header.type)}）`);
          continue;
        }

        const cwd = header.cwd ?? null;
        const act = lastActivityOf(file);
        sessions.push(
          makeSession({
            agent: "pi",
            // header 里的 id 才是 agent 认的会话 id，不是从文件名里切出来的那段
            sessionId: header.id ?? name.replace(/\.jsonl$/i, ""),
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
  }

  return { sessions, problems };
}
