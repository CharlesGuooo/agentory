import { headMessages, tailMessages, type Msg, type SessionRef } from "../sessions/messages";
import { MAX_CANDIDATES, pickInformative, stripWrapper } from "../sessions/preview";

/**
 * 摘要要发出去的东西 —— 按 D-7：**首条 prompt + 过滤后的尾部**。
 *
 * ## 为什么只发首条不够
 *
 * 会话会漂移。尾部在做的事经常和首条 prompt 完全无关，只发首条只能说明它
 * **出发时**要干什么。
 *
 * ## 为什么尾部必须过滤（这是这个功能能不能存在的前提）
 *
 * 实测：尾部 56% 是 `tool_result` / `tool_use` 行，平均 63.6 KB、最大 361 KB。
 * **用户的源码就藏在 `tool_result` 里。** 把它发给第三方模型是这个产品最不能犯的错误。
 *
 * 过滤不靠黑名单，靠 `messages.ts` 的「只取 text 片段」—— 工具输出根本不是 text 片段，
 * 它出不来。这里再加两层：剥掉系统注入的包装消息、逐条截断、整体封顶。
 *
 * 过滤同时解决三件事：**隐私**、成本（63.6 KB → 4 KB）、上下文爆掉。
 */

/** 单条消息最多留多少字。长回答留个开头就够表达它在谈什么。 */
export const MSG_MAX_CHARS = 500;
/** 整个载荷的字节上限。 */
export const TOTAL_MAX_BYTES = 4096;
/** 尾部取几条。 */
const TAIL_MSGS = 10;

export interface PayloadPart {
  role: Msg["role"];
  text: string;
  /** 被截断过。界面展示载荷时要如实标出来。 */
  truncated: boolean;
}

export interface Payload {
  /** 首条有信息量的用户消息。取不到就是 null。 */
  head: string | null;
  tail: PayloadPart[];
  /** 载荷实际字节数（UTF-8）。 */
  bytes: number;
  /** 为了构造它从磁盘读了多少字节。让「绝不整文件读」可断言。 */
  bytesRead: number;
}

const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");

/** 把一条消息收拾干净：剥包装、压空白、截断。整条都是噪音就返回 null。 */
function clean(m: Msg): PayloadPart | null {
  const unwrapped = stripWrapper(m.text);
  if (unwrapped === null) return null;
  const t = unwrapped.replace(/\s+/gu, " ").trim();
  if (t.length === 0) return null;
  return {
    role: m.role,
    text: t.slice(0, MSG_MAX_CHARS),
    truncated: t.length > MSG_MAX_CHARS,
  };
}

/**
 * 构造一条会话的摘要载荷。
 *
 * **从尾部往前装**：越靠后的消息越能说明这个会话此刻在做什么，
 * 装不下时该丢的是更早的那些。
 */
export function buildPayload(s: SessionRef): Payload {
  // 只要用户消息，且要几条由 pickInformative 说了算 —— 多要的它也不看
  const head = headMessages(s, MAX_CANDIDATES, "user");
  const tail = tailMessages(s, TAIL_MSGS);

  const headText = pickInformative(head.msgs.map((m) => m.text), MSG_MAX_CHARS);

  const parts: PayloadPart[] = [];
  let used = headText === null ? 0 : bytesOf(headText);
  for (const m of [...tail.msgs].reverse()) {
    const c = clean(m);
    if (!c) continue;
    const cost = bytesOf(c.text) + 8; // 8 ≈ 角色标签与换行
    if (used + cost > TOTAL_MAX_BYTES) break;
    used += cost;
    parts.unshift(c);
  }

  return {
    head: headText,
    tail: parts,
    bytes: used,
    bytesRead: head.bytesRead + tail.bytesRead,
  };
}

/** 载荷渲染成给模型看的文本。界面上的「看看会发送什么」展示的就是这个。 */
export function renderPayload(p: Payload): string {
  const lines: string[] = [];
  if (p.head !== null) lines.push(`[开头] ${p.head}`);
  for (const m of p.tail) {
    lines.push(`[${m.role === "user" ? "用户" : "助手"}] ${m.text}${m.truncated ? " …" : ""}`);
  }
  return lines.join("\n");
}
