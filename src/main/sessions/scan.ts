import { t } from "../../shared/i18n";
import { existsSync } from "node:fs";
import { previewOf } from "./preview";
import type { AgentId, ScanResult, Session } from "./types";

/**
 * 一个 agent 的扫描器。
 *
 * 刻意只是「一个函数 + 它属于哪个 agent」，不是 `AgentAdapter` 那种接口 ——
 * 按 D-11，接口的形状应由五个实现共同决定，等它们都写完了再抽。
 */
export interface Scanner {
  agent: AgentId;
  run(): ScanResult;
}

/**
 * 跑所有扫描器，合并成一张按最后活动时间倒序的表。
 *
 * 单个 agent 挂掉不影响其余的 —— 用户机器上五个 agent 的存储各自独立，
 * 一个读不动没有理由让整张表消失。
 */
export function scanAll(scanners: Scanner[]): ScanResult {
  const sessions: Session[] = [];
  const problems: string[] = [];

  for (const { agent, run } of scanners) {
    try {
      const r = run();
      for (const s of r.sessions) {
        // 纠正矛盾状态：cwd 为 null 就不可能存在。
        // 与其把矛盾传给下游让每个调用方各自防御，不如在这里收口。
        const fixed = s.cwd === null && s.cwdExists ? { ...s, cwdExists: false } : s;
        // 预览接在这里而不是五个扫描器里 —— 这是它们唯一的汇合点，接一次就够。
        // 实测代价：整轮扫描 336 → 665 ms（本机 433 条）。
        const preview = previewOf(fixed).text;
        sessions.push(preview === null ? fixed : { ...fixed, preview });
      }
      for (const p of r.problems) problems.push(`[${agent}] ${p}`);
    } catch (e) {
      problems.push(t("scan.failed", { agent, msg: (e as Error).message }));
    }
  }

  sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  return { sessions, problems };
}

/**
 * 造一条会话记录，`cwdExists` 由 `cwd` 派生。
 *
 * 这个派生规则原本在五个扫描器里各写一遍 —— 写五遍就有五次写错的机会。
 * 收在这里之后，「cwd 为 null 时 cwdExists 必然为 false」不可能被某个扫描器漏掉。
 *
 * 放在 scan.ts 而不是 types.ts：types.ts 必须保持纯类型，
 * 否则渲染层 import 那边的纯函数（如 filterSessions）会被连带拉进 node:fs。
 */
export function makeSession(s: Omit<Session, "cwdExists">): Session {
  return { ...s, cwdExists: s.cwd !== null && existsSync(s.cwd) };
}
