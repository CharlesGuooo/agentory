import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findJsonString, lastActivityOf, lastTimestamp, readHead, readTail } from "./jsonl";

const scratch = mkdtempSync(join(tmpdir(), "agentory-jsonl-"));
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 残留无害 */
  }
});

function write(name: string, content: string): string {
  const p = join(scratch, name);
  writeFileSync(p, content);
  return p;
}

/** 造一个大文件：第一行有答案，中间灌大量填充，最后一行有时间戳。 */
function bigFile(name: string, padMb: number): string {
  const head = JSON.stringify({ type: "session", cwd: "C:\\real\\path" }) + "\n";
  const pad = (JSON.stringify({ type: "pad", junk: "x".repeat(900) }) + "\n").repeat(
    Math.round((padMb * 1024 * 1024) / 950),
  );
  const tail = JSON.stringify({ type: "message", timestamp: "2026-08-01T10:00:00.000Z" }) + "\n";
  return write(name, head + pad + tail);
}

describe("readHead", () => {
  it("够行数就停，不把整个文件读进来", () => {
    const p = bigFile("big-head.jsonl", 8);
    const size = statSync(p).size;
    const r = readHead(p, 2);
    expect(r.lines).toHaveLength(2);
    // 这条断言就是规格里「绝不整文件读」的落测
    expect(r.bytesRead).toBeLessThan(size / 50);
  });

  it("文件行数不足时返回已有的行", () => {
    const p = write("short.jsonl", '{"a":1}\n{"b":2}\n');
    expect(readHead(p, 10).lines).toHaveLength(2);
  });

  it("空文件返回空数组", () => {
    expect(readHead(write("empty.jsonl", ""), 5).lines).toEqual([]);
  });
});

describe("readTail", () => {
  it("只读末尾指定的字节数", () => {
    const p = bigFile("big-tail.jsonl", 8);
    const r = readTail(p, 4096);
    expect(r.bytesRead).toBe(4096);
    expect(r.text).toContain("2026-08-01T10:00:00.000Z");
  });

  it("文件比窗口小时读整个文件", () => {
    const p = write("tiny.jsonl", "abc");
    expect(readTail(p, 4096).bytesRead).toBe(3);
  });
});

describe("lastTimestamp", () => {
  it("取最后一个，不是第一个", () => {
    const t = lastTimestamp(
      '{"timestamp":"2026-01-01T00:00:00Z"}\n{"timestamp":"2026-08-01T00:00:00Z"}',
    );
    expect(t?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("没有时间戳时返回 null", () => {
    expect(lastTimestamp('{"type":"last-prompt"}')).toBeNull();
  });

  it("跳过无法解析的时间戳", () => {
    const t = lastTimestamp('{"timestamp":"2026-08-01T00:00:00Z"}\n{"timestamp":"根本不是时间"}');
    expect(t?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("lastActivityOf", () => {
  it("用内容里的时间戳，即使 mtime 晚得多", () => {
    // 复刻实测到的真实情形：agent 追加了不带时间戳的簿记记录，mtime 被推到 8 天后
    const p = write(
      "drift.jsonl",
      '{"timestamp":"2026-08-01T00:00:00Z"}\n{"type":"last-prompt","text":"x"}\n',
    );
    const later = new Date("2026-08-09T00:00:00Z");
    utimesSync(p, later, later);

    const r = lastActivityOf(p);
    expect(r.exact).toBe(true);
    expect(r.at.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // 差了 8 天 —— 用 mtime 会让这个会话在排序里插到最前面
    expect(statSync(p).mtimeMs - r.at.getTime()).toBeGreaterThan(7 * 24 * 3600 * 1000);
  });

  it("内容里没有时间戳时退回 mtime，并标注为不精确", () => {
    const p = write("nots.jsonl", '{"type":"last-prompt"}\n');
    const r = lastActivityOf(p);
    expect(r.exact).toBe(false);
    // 和实现用的是同一个值（statSync().mtime），不要拿 mtimeMs 去 floor —— 亚毫秒取整会差 1
    expect(r.at.getTime()).toBe(statSync(p).mtime.getTime());
  });
});

describe("findJsonString", () => {
  it("返回解码后的路径，不是转义形式", () => {
    // JSONL 里的 Windows 路径写作双反斜杠；不解码就会得到一条不存在的路径
    const real = "C:\\Users\\PC\\Desktop\\Recent\\local_GPU";
    const p = write("find.jsonl", `{"type":"mode"}\n{"cwd":${JSON.stringify(real)}}\n`);
    expect(findJsonString(p, 40, "cwd")).toBe(real);
  });

  it("超出行数窗口就找不到", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `{"n":${i}}`).join("\n");
    const p = write("deep.jsonl", `${lines}\n{"cwd":"C:/late"}\n`);
    expect(findJsonString(p, 10, "cwd")).toBeNull();
  });

  it("字段不存在时返回 null", () => {
    expect(findJsonString(write("nocwd.jsonl", '{"type":"mode"}\n'), 40, "cwd")).toBeNull();
  });
});
