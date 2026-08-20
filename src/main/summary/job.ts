import type { Session } from "../sessions/types";
import { isStale, summaryKey, type SummaryEntry } from "./cache";
import { summarize, type SummaryResult } from "./deepseek";
import { buildPayload, renderPayload } from "./payload";

/**
 * 批量摘要。
 *
 * 按 D-13：**不建作业队列**。续做 =「列出目标范围里还没有缓存的，接着做」，
 * 进度 =「已缓存 / 目标总数」。天然幂等、天然可续、崩溃安全、零额外状态。
 *
 * 这和 `restoreSerially` 是同一个形状：串行、一个失败不中断其余、逐条报进度。
 */

/**
 * 还需要摘的会话。
 *
 * **OpenCode 一律跳过**（D-7）：它自带的 `title` 是模型生成的真标题，
 * 质量比我们从片段里重做的还好，花钱重做一遍是浪费。
 */
export function pending(targets: Session[], cache: Map<string, SummaryEntry>): Session[] {
  return targets.filter((s) => {
    if (s.agent === "opencode") return false;
    const hit = cache.get(summaryKey(s.agent, s.sessionId));
    return hit === undefined || isStale(hit, s.lastActivity);
  });
}

export interface JobOutcome {
  session: Session;
  result: SummaryResult;
}

/**
 * 串行跑完一批。
 *
 * 串行不是因为 API 限流（v4-flash 允许 2500 并发），是因为**用户随时可能关掉应用** ——
 * 串行时「已经写进缓存的」永远是一个前缀，续做逻辑因此不需要任何额外状态。
 */
export async function runJob(
  todo: Session[],
  key: string,
  onDone: (o: JobOutcome, done: number, total: number) => void,
  shouldStop: () => boolean = () => false,
): Promise<JobOutcome[]> {
  const out: JobOutcome[] = [];
  for (const [i, session] of todo.entries()) {
    if (shouldStop()) break;
    const payload = renderPayload(buildPayload(session));
    const result = await summarize(payload, key);
    const o = { session, result };
    out.push(o);
    onDone(o, i + 1, todo.length);
  }
  return out;
}

/** 把一次成功的结果变成缓存条目。 */
export const toEntry = (
  s: Session,
  text: { zh: string; en: string },
  model: string,
): SummaryEntry => ({
  agent: s.agent,
  sessionId: s.sessionId,
  text,
  model,
  at: new Date().toISOString(),
  sourceLastActivity: s.lastActivity.toISOString(),
});
