import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { entries: [], warnings: [`文件不是合法 JSON：${(e as Error).message}`] };
  }

  const list = (parsed as { sessions?: unknown })?.sessions;
  if (!Array.isArray(list)) {
    return { entries: [], warnings: ["文件结构不对：缺少 sessions 数组"] };
  }

  const entries: T[] = [];
  const warnings: string[] = [];
  list.forEach((raw, i) => {
    try {
      entries.push(parseOne(raw, i));
    } catch (e) {
      warnings.push(`跳过条目：${(e as Error).message}`);
    }
  });

  return { entries, warnings };
}

/** 写一个条目文件。每次变化立即落盘，不防抖 —— 防抖会开出「崩溃时丢最后一次变化」的窗口（D-W5）。 */
export function saveEntryFile<T>(path: string, entries: T[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, sessions: entries }, null, 2)}\n`);
}
