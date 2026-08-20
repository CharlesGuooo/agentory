import { t } from "../../shared/i18n";
import { loadEntryFile, saveEntryFile } from "../entryFile";
import type { AgentId } from "../sessions/types";

/**
 * 摘要缓存 —— D-6 说的第二个 JSON 文件，到这一刀才真的建起来。
 *
 * **复用 `entryFile.ts` 的落盘外壳**：它已经有「坏文件绝不写回、单条坏只跳过那条」
 * 的语义和测试。摘要是花过钱的东西，因为一条记录格式不对就把整份缓存清掉，
 * 代价是让用户重新付一次费。
 */

const AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

export interface SummaryEntry {
  agent: AgentId;
  sessionId: string;
  /**
   * **双语。** 一次 API 调用同时要中英两段（见 `deepseek.ts`）——
   * 切语言时直接换，不重新花钱。
   *
   * 结构从 `string` 改成对象是**故意的破坏性变更**：旧条目会在 `parseEntry` 里
   * 校验失败被跳过，而 `entryFile.ts` 的「有损加载先写 .bak」会把它们原样留在
   * `summaries.json.bak` 里。不写迁移代码，也不毁掉任何东西。
   */
  text: { zh: string; en: string };
  model: string;
  /** 生成时间，ISO。 */
  at: string;
  /**
   * 生成时那条会话的 `lastActivity`。
   *
   * 会话是 append-only 的：之后又聊了几轮，摘要就过期了。存下当时的水位线，
   * 下次批量跑到它时一比就知道要不要重摘。**过期的照常显示** —— 旧摘要也比没有强。
   */
  sourceLastActivity: string;
}

/** 旧格式（`text` 是字符串）在这里就被判掉，于是整条被跳过。 */
const isBilingual = (v: unknown): v is { zh: string; en: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { zh?: unknown }).zh === "string" &&
  ((v as { zh: string }).zh).length > 0 &&
  typeof (v as { en?: unknown }).en === "string" &&
  ((v as { en: string }).en).length > 0;

export const summaryKey = (agent: AgentId, sessionId: string): string => `${agent}|${sessionId}`;

function parseEntry(raw: unknown, index: number): SummaryEntry {
  if (typeof raw !== "object" || raw === null) throw new Error(t("store.notObject", { i: index + 1 }));
  const o = raw as Record<string, unknown>;
  const { agent, sessionId, text, model, at, sourceLastActivity } = o;
  if (typeof agent !== "string" || !AGENTS.includes(agent as AgentId)) {
    throw new Error(t("store.badAgent", { i: index + 1, v: JSON.stringify(agent) }));
  }
  if (typeof sessionId !== "string" || !sessionId) throw new Error(t("store.noSessionId", { i: index + 1 }));
  if (!isBilingual(text)) throw new Error(t("store.noText", { i: index + 1 }));
  return {
    agent: agent as AgentId,
    sessionId,
    text,
    model: typeof model === "string" ? model : "",
    at: typeof at === "string" ? at : new Date(0).toISOString(),
    sourceLastActivity:
      typeof sourceLastActivity === "string" ? sourceLastActivity : new Date(0).toISOString(),
  };
}

export interface LoadedSummaries {
  byKey: Map<string, SummaryEntry>;
  warnings: string[];
}

export function loadSummaries(path: string): LoadedSummaries {
  const { entries, warnings } = loadEntryFile(path, parseEntry);
  return {
    byKey: new Map(entries.map((e) => [summaryKey(e.agent, e.sessionId), e])),
    warnings,
  };
}

export function saveSummaries(path: string, byKey: Map<string, SummaryEntry>): void {
  saveEntryFile(path, [...byKey.values()]);
}

/** 会话在摘要之后又动过了吗。 */
export const isStale = (e: SummaryEntry, lastActivity: Date): boolean =>
  lastActivity.getTime() > new Date(e.sourceLastActivity).getTime();
