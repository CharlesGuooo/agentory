import { scanClaude } from "./claude";
import { scanCodex } from "./codex";
import { scanGrok } from "./grok";
import { scanOpenCode } from "./opencode";
import { scanPi } from "./pi";
import { scanAll, type Scanner } from "./scan";
import type { ScanResult } from "./types";

/**
 * 五个 agent 的扫描器。
 *
 * 刻意保持成一个数组字面量 —— 按 D-11，五个实现的共同点还没清楚到可以抽接口。
 * 每个 `run` 都用各自的默认存储路径；测试要指定路径时直接调具体函数。
 */
export const allScanners: Scanner[] = [
  { agent: "claude", run: () => scanClaude() },
  { agent: "codex", run: () => scanCodex() },
  { agent: "opencode", run: () => scanOpenCode() },
  { agent: "pi", run: () => scanPi() },
  { agent: "grok", run: () => scanGrok() },
];

/** 扫描本机全部 agent 的会话，按最后活动时间倒序。 */
export function scanAllAgents(): ScanResult {
  return scanAll(allScanners);
}
