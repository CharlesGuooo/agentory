import { t } from "../shared/i18n";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 工作集与收藏夹共用的落盘外壳。
 *
 * 抽出来不是为了"复用"这个词本身，而是为了让**「绝不替用户销毁记录」这条已有的测试
 * 同时守住两个文件**。复制一份校验代码 = 那条测试只守住其中一个，
 * 而另一个会在某次手改坏文件时把用户的记录抹掉。
 *
 * 磁盘格式两边一样：`{version:1, sessions:[…]}`，带缩进 —— 用户应该能直接打开手改。
 * 字段校验各自不同，所以由调用方传 `parseOne`。
 */

export interface LoadedEntries<T> {
  entries: T[];
  /** 被跳过的条目及原因。调用方负责展示 —— 不静默丢弃用户的记录。 */
  warnings: string[];
}

/**
 * 读一个条目文件。
 *
 * **任何读取失败都只返回空列表 + 告警，绝不写回** ——
 * 文件可能是用户手改坏的，读不动就把它抹了，等于替用户销毁记录。
 * 单条坏掉只跳过那条：没有理由让一条坏记录清空整个列表。
 */
export function loadEntryFile<T>(
  path: string,
  parseOne: (raw: unknown, index: number) => T,
): LoadedEntries<T> {
  if (!existsSync(path)) return { entries: [], warnings: [] };

  const raw = readFileSync(path, "utf8");

  /**
   * **读不动的东西，先原样存一份，再往下走。**
   *
   * 上面那句「绝不写回」原本只保证到**下一次正常写入之前**：
   * 20 条里坏了 1 条 → 读出 19 条 → 用户新加一条 → `commit()` 把 20 条写回去 →
   * 那条坏的永远没了。跳过它是对的（读不动就是读不动），
   * 悄悄销毁它不是 —— 尤其这份文件我们明确邀请用户手改。
   *
   * 只在**第一次**坏读时写：否则用户修好文件再启动一次，备份就被修好的版本盖掉，
   * 而那正是最需要旧那份的时候。
   */
  const keep = (warnings: string[]): string[] => {
    const bak = `${path}.bak`;
    if (!existsSync(bak)) {
      writeFileSync(bak, raw);
      return [...warnings, `原文件已备份到 ${bak}`];
    }
    return warnings;
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { entries: [], warnings: keep([`文件不是合法 JSON：${(e as Error).message}`]) };
  }

  const list = (parsed as { sessions?: unknown })?.sessions;
  if (!Array.isArray(list)) {
    return { entries: [], warnings: keep(["文件结构不对：缺少 sessions 数组"]) };
  }

  const entries: T[] = [];
  const warnings: string[] = [];
  list.forEach((item, i) => {
    try {
      entries.push(parseOne(item, i));
    } catch (e) {
      warnings.push(t("store.skipped", { msg: (e as Error).message }));
    }
  });

  return { entries, warnings: warnings.length ? keep(warnings) : warnings };
}

/**
 * 写一个条目文件。每次变化立即落盘，不防抖 —— 防抖会开出「崩溃时丢最后一次变化」的窗口（D-W5）。
 *
 * **先写临时文件再 rename。** 裸 `writeFileSync` 在写到一半时断电/被杀，留下的是
 * 半个 JSON —— 下次启动整份工作集读不出来，然后正好触发上面那条销毁链。
 * `rename` 在同一个卷上是原子的：要么是旧的完整文件，要么是新的完整文件，没有中间态。
 *
 * 临时文件名带 pid：两个实例同时写时不会互相踩（单实例锁已经挡了绝大多数，
 * 但便携版和安装版是两个 userData，仍可能并存）。
 */
export function saveEntryFile<T>(path: string, entries: T[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions: entries }, null, 2)}\n`);
  renameSync(tmp, path);
}
