import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readHead, readTail } from "./jsonl";
import { BUSY_TIMEOUT_MS } from "./opencode";
import type { AgentId, Session } from "./types";

/**
 * 五个 agent 的消息提取，**收在这一处**。
 *
 * 之前只有 `preview.ts` 需要「首条用户消息」，格式知识就住在那里。现在摘要还需要
 * 「最后 N 条消息」，如果再写一份，五个 agent 的格式知识就散成了两份 ——
 * 那正是当初 `filterSessions` 被渲染层抄了一遍的错误。所以先把它收口，再往上加。
 *
 * ## 工具输出是怎么被挡住的
 *
 * **不是靠列黑名单，是靠只取 `type === "text"` 的片段。**
 * `tool_result` / `tool_use` 在五个 agent 里都是**别的片段类型**，
 * 取不到 text 的消息自然就成了空消息，被丢掉。
 * 这条很重要：实测尾部 56% 是工具行，而**用户的源码就藏在 `tool_result` 里**。
 */

export interface Msg {
  role: "user" | "assistant";
  text: string;
}

export interface MsgResult {
  msgs: Msg[];
  /** 读了多少字节。让「绝不整文件读」可断言。opencode 走 SQLite，恒为 0。 */
  bytesRead: number;
}

export type SessionRef = Pick<Session, "agent" | "sessionId" | "source">;

const HEAD_LINES = 40;
const HEAD_BYTES = 256 * 1024;

/**
 * 尾部渐进扩大地读。
 *
 * **固定窗口不行**：实测单条 `tool_result` 最大 361 KB，读 64 KB 可能整个落在
 * 一条工具输出里面，一条纯文本消息都拿不到 —— 那样摘要就只剩首条 prompt，等于白做。
 * 拿够就停；到顶还不够也停，绝不把整个文件读进来（存在 195 MB 的单会话）。
 */
const TAIL_STEPS = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

/** 消息里的文本。**只认 text 片段** —— 工具输出因此天然出不来。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .filter((p) => p["type"] === undefined || p["type"] === "text" || p["type"] === "input_text")
    .map((p) => String(p["text"] ?? p["input_text"] ?? ""))
    .join("\n")
    .trim();
}

const asRole = (r: unknown): Msg["role"] | null =>
  r === "user" || r === "assistant" ? r : null;

/**
 * 一行 JSONL → 角色 + **还没提取文本的**原始内容。认不出就是 null。
 *
 * 分成两步而不是一步到位，是因为 `textOf` 是这里唯一贵的操作
 * （助手行里的 `tool_use` 数组可以有几百 KB），而调用方常常只要一种角色。
 * 先判角色、再提文本，全量扫描少花约 100 ms。
 */
type LineParser = (o: Record<string, unknown>) => { role: Msg["role"]; content: unknown } | null;

const at = (role: string | undefined, content: unknown): ReturnType<LineParser> => {
  const r = asRole(role);
  return r === null ? null : { role: r, content };
};

const PARSERS: Record<Exclude<AgentId, "opencode">, LineParser> = {
  claude: (o) =>
    at(o["type"] as string, (o["message"] as { content?: unknown } | undefined)?.content),
  codex: (o) => {
    const p = o["payload"] as { type?: string; role?: string; content?: unknown } | undefined;
    return p?.type === "message" ? at(p.role, p.content) : null;
  },
  pi: (o) => {
    if (o["type"] !== "message") return null;
    const m = o["message"] as { role?: string; content?: unknown } | undefined;
    return at(m?.role, m?.content);
  },
  grok: (o) => at(o["type"] as string, o["content"]),
};

/** grok 的 `source` 是目录（一个会话一个目录），消息在 chat_history.jsonl 里最干净。 */
const jsonlPath = (s: SessionRef): string =>
  s.agent === "grok" ? join(s.source, "chat_history.jsonl") : s.source;

/** `stopAt` 只给取头部用 —— 取尾部要的是最后 N 条，提前停会停在错的一端。 */
function parseLines(
  lines: string[],
  agent: Exclude<AgentId, "opencode">,
  role?: Msg["role"],
  stopAt?: number,
): Msg[] {
  const take = PARSERS[agent];
  const out: Msg[] = [];
  for (const line of lines) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 尾部按字节切，首行几乎必然是残行 —— 丢掉，不让它污染列表
    }
    const r = take(o);
    if (r === null || (role !== undefined && r.role !== role)) continue;
    const text = textOf(r.content);
    if (text.length === 0) continue;
    out.push({ role: r.role, text });
    if (stopAt !== undefined && out.length >= stopAt) break;
  }
  return out;
}

/**
 * opencode 的消息在 SQLite 里。`asc=false` 取末尾。
 *
 * **角色过滤必须推进 SQL。** 一条助手消息会被拆成很多 part（工具调用、思考、分段文本），
 * 想拿到 N 条用户消息就得多要很多行，再在 JS 里筛 —— 实测那样每条会话要 28.3 ms，
 * 166 条就是 4.7 秒，把全量扫描从 0.67 秒拖到 10 秒。
 * 在 SQL 里筛之后回到 1 ms 上下。
 */
function openCodeMessages(
  dbPath: string,
  sessionId: string,
  max: number,
  asc: boolean,
  role?: Msg["role"],
): Msg[] {
  let db: DatabaseSync | null = null;
  try {
    // 锁等待见 `BUSY_TIMEOUT_MS` 的注释：不等的话并发读会直接失败，预览变空
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
    // 排序方向只能拼进 SQL（不能参数化），所以它必须来自这里的字面量，绝不能来自外部
    const dir = asc ? "ASC" : "DESC";
    const roleSql = role ? " AND json_extract(m.data, '$.role') = ?" : "";
    const args: (string | number)[] = role ? [sessionId, role] : [sessionId];
    const rows = db
      .prepare(
        `SELECT m.data AS m, p.data AS p
           FROM message m JOIN part p ON p.message_id = m.id
          WHERE m.session_id = ?${roleSql}
          ORDER BY m.rowid ${dir}, p.rowid ${dir}
          LIMIT ?`,
      )
      // 一条消息拆成多个 part，所以要的行数比消息数多。**倍数取决于筛没筛角色**：
      // 筛了（只要用户消息）每条消息就一两个 part，4 倍够；没筛（取尾部要两种角色）
      // 会撞上助手那一长串工具调用与推理片段 —— 实测 4 倍时整个窗口可能一条纯文本都没有，
      // 尾部直接返回空。这正是这条 SQL 唯一踩过的坑。
      .all(...args, max * (role ? 4 : 20)) as { m: string; p: string }[];
    const out: Msg[] = [];
    for (const r of rows) {
      try {
        const got = asRole((JSON.parse(r.m) as { role?: string }).role);
        const part = JSON.parse(r.p) as { type?: string; text?: string };
        const text = part.type === "text" ? (part.text ?? "").trim() : "";
        if (got !== null && text.length > 0) out.push({ role: got, text });
      } catch {
        continue;
      }
    }
    return asc ? out : out.reverse();
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * 会话开头的若干条消息。
 *
 * `role` 只是**过滤条件**，不是筛完再取 —— 它会被推进 opencode 的 SQL，
 * 否则拿 N 条用户消息要先取一大堆助手 part（见 `openCodeMessages` 的注释）。
 */
export function headMessages(s: SessionRef, max: number, role?: Msg["role"]): MsgResult {
  if (s.agent === "opencode") {
    return { msgs: openCodeMessages(s.source, s.sessionId, max, true, role), bytesRead: 0 };
  }
  const { lines, bytesRead } = readHead(jsonlPath(s), HEAD_LINES, 64 * 1024, HEAD_BYTES);
  return { msgs: parseLines(lines, s.agent, role, max), bytesRead };
}

/** 会话结尾的若干条消息。窗口不够就扩大再读，见 `TAIL_STEPS`。 */
export function tailMessages(s: SessionRef, max: number): MsgResult {
  if (s.agent === "opencode") {
    return { msgs: openCodeMessages(s.source, s.sessionId, max, false), bytesRead: 0 };
  }
  const path = jsonlPath(s);
  let last: MsgResult = { msgs: [], bytesRead: 0 };
  for (const window of TAIL_STEPS) {
    const { text, bytesRead } = readTail(path, window);
    // 首行按字节切开，多半是残的 —— 直接丢
    const lines = text.split("\n").slice(1).filter(Boolean);
    const msgs = parseLines(lines, s.agent);
    last = { msgs: msgs.slice(-max), bytesRead };
    if (msgs.length >= max) break;
    // 窗口已经覆盖了整个文件，再扩大也没有更多东西
    if (bytesRead < window) break;
  }
  return last;
}
