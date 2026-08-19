import { headMessages, type SessionRef } from "./messages";

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

/**
 * 截断上限。
 *
 * **不按盒子定。** 原来是 46，注释写的是「窄侧栏折两行大约就是这个量」——
 * 那是**显示约束漏进了数据层**：CSS 已经在 clamp 了，这里再切一遍，切掉的就再也
 * 长不回来，还会被 `workspace.json` 的 `label` 持久化下去。用户右键「复制摘要」
 * 复制到的正是这个 46 字的半句话，而他以为是复制没复制全。
 *
 * 新的依据是数据本身：实测 283 条真摘要**最长 122 字**（中位数 46）。
 * 上限要盖得住两个文本来源，两边行为才一致，160 是留了余量的那个数。
 *
 * 这条只管界面。给 DeepSeek 的载荷走 `payload.ts` 的
 * `pickInformative(..., MSG_MAX_CHARS)`，那边是 500，本来就不受它影响。
 */
export const PREVIEW_MAX = 160;

/**
 * 最多看几条候选。防止一个满是注入的开头把整个头部翻完。
 * 导出是因为**取头部的人得知道要取几条** —— 多取的这里也不看，白读。
 */
export const MAX_CANDIDATES = 12;

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
/**
 * 剥掉系统注入的包装。整条都是注入就返回 null。
 *
 * 导出是因为**摘要载荷也要用它** —— 注入的系统提示既没有信息量，
 * 又要花 token，还会把模型的注意力带偏。规则只能有一份。
 */
export function stripWrapper(raw: string): string | null {
  const t = (USER_QUERY.exec(raw)?.[1] ?? raw).trim();
  if (!t) return null;
  if (OPEN_TAG.test(t)) return null;
  if (PLAIN_INJECTED.some((re) => re.test(t))) return null;
  return t;
}

export function pickInformative(candidates: string[], maxLen = PREVIEW_MAX): string | null {
  for (const raw of candidates.slice(0, MAX_CANDIDATES)) {
    // 先剥包装再判断 —— 包装里面才是用户的话
    const stripped = stripWrapper(raw);
    if (stripped === null) continue;
    const t = stripped.replace(/\s+/gu, " ").trim();
    if (SLASH.test(t)) continue;
    if (NO_WORDS.test(t)) continue;
    if (t.length < MIN_INFORMATIVE) continue;
    return t.slice(0, maxLen);
  }
  return null;
}

/**
 * 取一条会话的预览 —— 第 0 层：免费、离线、永不阻塞在网络上。
 *
 * 五个 agent 的格式知识不在这里，在 `messages.ts`：摘要（第 1 层）也要用它取尾部，
 * 散成两份就是当初 `filterSessions` 被抄一遍的错误重演。
 *
 * 取不到一律返回 `{text:null}`，不抛 —— 预览缺失不该让整轮扫描失败。
 */
export function previewOf(s: SessionRef): Preview {
  try {
    // 只要用户消息 —— 把过滤推给 messages.ts，它会进 opencode 的 SQL
    const { msgs, bytesRead } = headMessages(s, MAX_CANDIDATES, "user");
    return { text: pickInformative(msgs.map((m) => m.text)), bytesRead };
  } catch {
    return { text: null, bytesRead: 0 };
  }
}
