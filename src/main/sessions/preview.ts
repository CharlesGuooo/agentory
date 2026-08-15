import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readHead } from "./jsonl";
import type { Session } from "./types";

/**
 * 会话的「开头那句话」—— 在真摘要（D-7）做出来之前，行内第二行显示的东西。
 *
 * **这是占位，不是终点。** 实测本机 18 个 claude 会话，约 11 个能看出是什么，
 * 5 个完全没信息 —— 失败的全是开头很短那种（`看这里的文件，理解我要做什么`），
 * 真内容在第二条。所以规则是「取第一条**有信息量**的」，不是「取第一条」。
 *
 * Grok 自带的 `session_summary` 是反面证据：它就是首条消息的粗暴截断，
 * 产出 `"﻿Use brave web search to find out who won the"`（从句中切断，还带 BOM）。
 */

/** 截断上限。窄侧栏折两行大约就是这个量。 */
export const PREVIEW_MAX = 46;

/** 头部扫多少行找消息。与 `HEAD_LINES` 同量级 —— 那一段头部扫描时已经读过，页缓存里是热的。 */
const SCAN_LINES = 40;

/**
 * 头部最多读多少字节。
 *
 * 光按行数停挡不住 pi —— 它的头部有把整个 README 塞进去的 toolResult 行，
 * 40 行能有好几 MB。实测这条上限把 pi 从 18.8 ms/条压到个位数。
 */
const SCAN_BYTES = 256 * 1024;

/** 最多看几条候选。防止一个满是注入的开头把整个头部翻完。 */
const MAX_CANDIDATES = 12;

/** 低于这个长度就认为没信息 —— 实测失败样本全部落在这条线以下。 */
const MIN_INFORMATIVE = 20;

export interface Preview {
  /** 取不到就是 null，**不是空串** —— 空串会让界面显示成空白，而空白看起来像还在加载。 */
  text: string | null;
  /** 读了多少字节。让「绝不整文件读」可断言，不必靠计时去猜。opencode 走 SQLite，恒为 0。 */
  bytesRead: number;
}

/**
 * grok 把用户真正打的字包在 `<user_query>` 里。先剥开，里面才是用户的话。
 */
const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/;

/**
 * **以 XML 式开标签起头的一律当注入。**
 *
 * 这条规则是被实测逼出来的。`DESIGN.md §2.6` 那张注入表是白名单，
 * 而本变更在真实数据里连着撞见三个表上没有的包装：
 *
 * - grok 的 `<user_query>`（把用户真话包起来）
 * - codex 的 `<recommended_plugins>`（以**用户消息**身份发的插件推荐）
 * - 加上表里原有的 `<system-reminder>` / `<user_info>` / `<command-*>`
 *
 * 白名单永远列不全，而且漏掉的代价是用户在界面上看见一段系统提示。
 * 换成结构规则：真人打字不会以 `<tag>` 开头。
 */
const OPEN_TAG = /^<[a-z][\w-]*[\s>]/i;

/** 不带尖括号的两种注入，照 §2.6 保留。 */
const PLAIN_INJECTED = [/^Caveat:/, /^#\s*AGENTS\.md/];

/** 斜杠命令。pi 的 `/help` 实测就是这种 —— 是命令不是话题。 */
const SLASH = /^\/[a-z][\w-]*/i;

/** 只有符号没有字的串。实测有一条会话开头就是一整行等号。 */
const NO_WORDS = /^[\s\p{P}\p{S}]*$/u;

/**
 * 从候选里挑第一条有信息量的。
 *
 * 顺序：剥注入 → 跳斜杠命令 → 压缩空白 → 太短的跳过 → 截断。
 * 压缩空白要在判长度**之前**做 —— 一堆换行撑出来的长度不是信息量。
 */
export function pickInformative(candidates: string[]): string | null {
  for (const raw of candidates.slice(0, MAX_CANDIDATES)) {
    // 先剥包装再判断 —— 包装里面才是用户的话
    const unwrapped = USER_QUERY.exec(raw)?.[1] ?? raw;
    const t = unwrapped.replace(/\s+/gu, " ").trim();
    if (!t) continue;
    if (OPEN_TAG.test(t)) continue;
    if (PLAIN_INJECTED.some((re) => re.test(t))) continue;
    if (SLASH.test(t)) continue;
    if (NO_WORDS.test(t)) continue;
    if (t.length < MIN_INFORMATIVE) continue;
    return t.slice(0, PREVIEW_MAX);
  }
  return null;
}

/** 一条 JSONL 里的文本内容可能是字符串，也可能是 `[{type:"text",text}]`。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { text?: string } => typeof p === "object" && p !== null)
    .map((p) => p.text ?? "")
    .join("\n");
}

/** 逐行解析头部，把符合条件的行映射成文本。解析不了的行跳过，不让一行坏 JSON 断掉整条。 */
function fromJsonl(path: string, take: (o: Record<string, unknown>) => string | null): Preview {
  const { lines, bytesRead } = readHead(path, SCAN_LINES, 64 * 1024, SCAN_BYTES);
  const out: string[] = [];
  for (const line of lines) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = take(o);
    if (t) out.push(t);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return { text: pickInformative(out), bytesRead };
}

const claude = (path: string): Preview =>
  fromJsonl(path, (o) => {
    if (o["type"] !== "user") return null;
    const m = o["message"] as { content?: unknown } | undefined;
    return textOf(m?.content);
  });

/** codex 把消息包在 `response_item.payload` 里，且 `role=="developer"` 是权限说明不是用户。 */
const codex = (path: string): Preview =>
  fromJsonl(path, (o) => {
    const p = o["payload"] as { type?: string; role?: string; content?: unknown } | undefined;
    if (p?.type !== "message" || p.role !== "user") return null;
    // codex 的 content 用的是 `input_text` 而不是 `text`
    const c = p.content;
    if (Array.isArray(c)) {
      return c
        .filter((x): x is Record<string, string> => typeof x === "object" && x !== null)
        .map((x) => x["text"] ?? x["input_text"] ?? "")
        .join("\n");
    }
    return textOf(c);
  });

const pi = (path: string): Preview =>
  fromJsonl(path, (o) => {
    if (o["type"] !== "message") return null;
    const m = o["message"] as { role?: string; content?: unknown } | undefined;
    if (m?.role !== "user") return null;
    return textOf(m.content);
  });

/** grok 的 `source` 是**目录**（一个会话一个目录），消息在 `chat_history.jsonl` 里最干净。 */
const grok = (dir: string): Preview =>
  fromJsonl(join(dir, "chat_history.jsonl"), (o) =>
    o["type"] === "user" ? textOf(o["content"]) : null,
  );

/**
 * opencode 的 `source` 是数据库路径，消息在 `message` / `part` 两张表里。
 *
 * 只读、带 `LIMIT` —— 这里没有"读了多少字节"的概念，对应的风险是全表扫，用 LIMIT 挡掉。
 */
function opencode(dbPath: string, sessionId: string): Preview {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT p.data AS d FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
         ORDER BY m.rowid, p.rowid LIMIT ?`,
      )
      .all(sessionId, MAX_CANDIDATES) as { d: string }[];
    const texts = rows.map((r) => {
      try {
        const p = JSON.parse(r.d) as { type?: string; text?: string };
        return p.type === "text" ? (p.text ?? "") : "";
      } catch {
        return "";
      }
    });
    return { text: pickInformative(texts), bytesRead: 0 };
  } catch {
    // 数据库被占用或结构变了 —— 取不到预览不是错误，界面自己会说"没有可读的开头"
    return { text: null, bytesRead: 0 };
  } finally {
    db?.close();
  }
}

/**
 * 取一条会话的预览。取不到一律返回 `{text:null}`，不抛 ——
 * 预览缺失不该让整轮扫描失败。
 *
 * 注意 `source` 三种含义：claude/codex/pi 是**文件**，grok 是**目录**，
 * opencode 是**数据库路径**（所以只有它还要 sessionId）。
 */
export function previewOf(s: Pick<Session, "agent" | "sessionId" | "source">): Preview {
  try {
    switch (s.agent) {
      case "claude":
        return claude(s.source);
      case "codex":
        return codex(s.source);
      case "pi":
        return pi(s.source);
      case "grok":
        return grok(s.source);
      case "opencode":
        return opencode(s.source, s.sessionId);
    }
  } catch {
    return { text: null, bytesRead: 0 };
  }
}
