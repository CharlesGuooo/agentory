/**
 * DeepSeek 客户端。**零依赖** —— Node 22 自带 `fetch`。
 *
 * 三个不能凭记忆写的事实（2026-08 查证）：
 *
 * 1. **`deepseek-chat` / `deepseek-reasoner` 两个别名已于 2026-07-24 弃用。**
 *    现在是 `deepseek-v4-flash` 与 `deepseek-v4-pro`。
 * 2. **两个模型都默认开思考模式。** 对一句话摘要那是纯浪费，必须显式
 *    `thinking: { type: "disabled" }` 关掉。
 * 3. 价格 2026-08-16 起改成峰谷计费（谷时半价），所以任何写死的费用估算
 *    都要标注它的来源日期。
 */

const ENDPOINT = "https://api.deepseek.com/chat/completions";

/** 便宜的那个。摘要这种任务不需要 pro。 */
export const MODEL = "deepseek-v4-flash";

/** 价格（USD / 百万 token），查证于 2026-08-15。峰谷计费启用后会变。 */
export const PRICE = { in: 0.14, out: 0.28, checkedAt: "2026-08-15" };

const SYSTEM = [
  "你在为一个开发者工具生成会话摘要。",
  "输入是一次 AI 编程会话的开头与结尾片段。",
  "用一句话说明这次会话在做什么，30 到 50 个字，不要标点结尾，不要引号，不要「本次会话」这类开场白。",
  "直接说事情本身，例如「把装机清单从双卡改成单卡并重算总价」。",
  "如果片段里看不出在做什么，就如实说看不出，不要编。",
].join("\n");

export interface SummaryOk {
  ok: true;
  text: string;
  model: string;
  /** 真实用量，用来在界面上说真话而不是估算。 */
  usage: { input: number; output: number };
}
export interface SummaryErr {
  ok: false;
  /** 给用户看的一句话。不含堆栈、不含 key。 */
  error: string;
  /** HTTP 状态码。网络层就失败了（超时、断网）时没有。 */
  status?: number;
}
export type SummaryResult = SummaryOk | SummaryErr;

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

async function once(payload: string, key: string, timeoutMs: number): Promise<SummaryResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: payload },
        ],
        // 默认是开着的。摘要不需要思考，开着只是多花输出 token。
        thinking: { type: "disabled" },
        max_tokens: 120,
        temperature: 0.2,
      }),
      signal: ctl.signal,
    });

    const body = (await r.json().catch(() => ({}))) as ChatResponse;
    if (!r.ok) {
      // 只把服务端那句话带出来。绝不回显请求体 —— 里面是用户的会话内容。
      return { ok: false, error: body.error?.message ?? `HTTP ${r.status}`, status: r.status };
    }
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, error: "模型没有返回内容" };
    return {
      ok: true,
      text,
      model: MODEL,
      usage: {
        input: body.usage?.prompt_tokens ?? 0,
        output: body.usage?.completion_tokens ?? 0,
      },
    };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "请求超时" : (e as Error).message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 摘要一段载荷。**失败不抛** —— 摘要失败该回落到第 0 层，不该让批量作业中断，
 * 更不该弹到用户脸上。
 *
 * 重试一次：网络抖动很常见，而重试一次的成本是 $0.00015。
 */
export async function summarize(payload: string, key: string): Promise<SummaryResult> {
  const first = await once(payload, key, 30_000);
  if (first.ok) return first;
  // 4xx 是我们自己的问题（key 不对、参数不对），重试必然再失败
  if (first.status !== undefined && first.status < 500) return first;
  return once(payload, key, 30_000);
}
