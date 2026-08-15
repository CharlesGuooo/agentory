import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * 读文件头部的前若干行。
 *
 * 分块读、够行数就停 —— 实测存在 195 MB 的单会话文件，整文件读是不可接受的。
 * 返回 `bytesRead` 是为了让「绝不整文件读」这条规格能被断言，而不是靠计时去猜。
 */
export function readHead(
  path: string,
  maxLines: number,
  chunk = 64 * 1024,
  /**
   * 字节上限。**按行数停是不够的** —— 实测 pi 的会话头部有把整个 README 塞进去的
   * toolResult 行，40 行能有好几 MB，读一条会话要 18.8 ms（其他 agent 是 0.5–3.3）。
   * 默认不限，只有取预览时才设，免得影响 cwd 提取那条已经稳定的路径。
   */
  maxBytes = Number.POSITIVE_INFINITY,
): {
  lines: string[];
  bytesRead: number;
} {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const buf = Buffer.alloc(chunk);
    let text = "";
    let bytesRead = 0;
    while (bytesRead < size && bytesRead < maxBytes) {
      const want = Math.min(chunk, size - bytesRead, maxBytes - bytesRead);
      const n = readSync(fd, buf, 0, want, bytesRead);
      if (n <= 0) break;
      bytesRead += n;
      text += buf.toString("utf8", 0, n);
      // 完整行数够了就停。留最后一行不算 —— 它可能被截断。
      const complete = text.split("\n").length - 1;
      if (complete >= maxLines) break;
    }
    const lines = text.split("\n").slice(0, maxLines).filter(Boolean);
    return { lines, bytesRead };
  } finally {
    closeSync(fd);
  }
}

/** 从文件末尾读最多 `maxBytes` 字节。用于取最后一条时间戳。 */
export function readTail(path: string, maxBytes = 16 * 1024): { text: string; bytesRead: number } {
  const size = statSync(path).size;
  const n = Math.min(maxBytes, size);
  if (n === 0) return { text: "", bytesRead: 0 };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return { text: buf.toString("utf8"), bytesRead: n };
  } finally {
    closeSync(fd);
  }
}

/** 头部扫多少行找字段。实测 Claude 的 cwd 在 40 行内命中。 */
export const HEAD_LINES = 40;

const TS = /"timestamp"\s*:\s*"([^"]+)"/g;

/** 取一段文本里最后一个可解析的 ISO 时间戳。 */
export function lastTimestamp(text: string): Date | null {
  let hit: Date | null = null;
  for (const m of text.matchAll(TS)) {
    const d = new Date(m[1]!);
    if (!Number.isNaN(d.getTime())) hit = d;
  }
  return hit;
}

/**
 * 会话的最后活动时间。
 *
 * **优先用内容里的时间戳，不用文件 mtime** —— 实测两者能差 8 天，
 * 因为 agent 会追加不带时间戳的簿记记录（如 Claude 的 `{"type":"last-prompt"}`），
 * 写入更新了 mtime 却不代表用户在此工作过。
 */
export function lastActivityOf(path: string): { at: Date; exact: boolean } {
  const t = lastTimestamp(readTail(path).text);
  if (t) return { at: t, exact: true };
  return { at: statSync(path).mtime, exact: false };
}

/**
 * 在头部若干行里找某个 JSON 字符串字段，返回**解码后**的值。
 *
 * 必须解码：JSONL 里的 Windows 路径是 `"C:\Users\PC"`（双反斜杠），
 * 正则抓到的是转义形式，直接用会得到一条不存在的路径。
 */
export function findJsonString(path: string, maxLines: number, key: string): string | null {
  // 用普通字符串拼而不是模板字面量 —— 模板里 `\s` 会退化成 `s`，正则就废了
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
  for (const line of readHead(path, maxLines).lines) {
    const m = line.match(re);
    if (m?.[1] === undefined) continue;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return null; // 转义坏掉了，宁可当作取不到，也不返回半解码的路径
    }
  }
  return null;
}
