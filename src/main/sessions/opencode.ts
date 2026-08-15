import { existsSync } from "node:fs";
import { agentPaths } from "../paths";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeSession } from "./scan";
import type { ScanResult, Session } from "./types";

/**
 * 锁等待上限。锁是毫秒级的，2 秒足够；再长就该让界面先出来而不是继续等。
 * 导出是因为读消息那边（`messages.ts`）开的是同一个库，必须用同一个值。
 */
export const BUSY_TIMEOUT_MS = 2000;

/** OpenCode 把所有会话放在一个 SQLite 库里。 */
export const defaultOpenCodeDb = (): string =>
  join(agentPaths().opencode.dataDir.path, "opencode.db");

interface Row {
  id: string;
  directory: string;
  title: string;
  time_updated: number;
}

/**
 * 五个 agent 里最简单的一个：`session` 表直接给出 id、真实目录、标题和更新时间，
 * 不需要解码目录名，也不需要扫任何文件。
 *
 * 用 Node 内置的 `node:sqlite`（Node 22+），零依赖 ——
 * 实测在 Electron 43 / Node 24.18 下可只读打开 824MB 带 WAL 的库。
 */
export function scanOpenCode(dbPath: string = defaultOpenCodeDb()): ScanResult {
  // 没装 opencode 不是错误
  if (!existsSync(dbPath)) return { sessions: [], problems: [] };

  const problems: string[] = [];
  const sessions: Session[] = [];

  // 只读打开。库可能正被 opencode 自己写着（有 WAL），我们绝不能碰它。
  //
  // `timeout` 不是可有可无的：实测并发读同一个库时会抛 `database is locked`，
  // 而这个异常会让**全部 166 条 opencode 会话从列表里整块消失**，
  // 用户只看到 opencode 那一栏空了。锁是暂时的，等一下就好 ——
  // 这正是 SQLite 的 busy_timeout 存在的理由，不用自己写重试。
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const rows = db
      .prepare("SELECT id, directory, title, time_updated FROM session")
      .all() as unknown as Row[];

    for (const row of rows) {
      try {
        // 空目录变 null，不留空串 —— 空串会被下游当成"有值"从而拼出错误路径
        const cwd = row.directory ? row.directory : null;
        const s: Session = makeSession({
          agent: "opencode",
          sessionId: row.id,
          cwd,
          lastActivity: new Date(row.time_updated),
          // 数据库里的时间是 agent 自己写的，权威
          lastActivityExact: true,
          source: dbPath,
        });
        // OpenCode 的标题实测质量很好，直接采纳，省掉一次模型调用
        if (row.title) s.nativeTitle = row.title;
        sessions.push(s);
      } catch (e) {
        problems.push(`会话 ${row.id} 解析失败：${(e as Error).message}`);
      }
    }
  } finally {
    db.close();
  }

  return { sessions, problems };
}
