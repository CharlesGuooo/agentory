import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { availableAgents, folderSuggestions, validateTarget } from "./launch";
import type { AgentId, Session } from "./types";

const scratch = mkdtempSync(join(tmpdir(), "agentory-launch-"));
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 残留无害 */
  }
});

function s(agent: AgentId, cwd: string | null, at: string, exists = true): Session {
  return {
    agent,
    sessionId: `${agent}-${at}`,
    cwd,
    cwdExists: cwd !== null && exists,
    lastActivity: new Date(at),
    lastActivityExact: true,
    source: "x",
  };
}

describe("availableAgents", () => {
  it("只列出能解析成可执行文件的", () => {
    const got = availableAgents((n) => {
      if (n === "codex" || n === "pi") throw new Error("PATH 中找不到");
      return { exe: `C:\\bin\\${n}.exe`, args: [], via: "direct" };
    });
    expect(got).toEqual(["claude", "opencode", "grok"]);
  });

  it("一个都解析不出时返回空列表，不抛错", () => {
    expect(
      availableAgents(() => {
        throw new Error("都没装");
      }),
    ).toEqual([]);
  });

  it("全部可用时五个都在，顺序稳定", () => {
    const got = availableAgents(() => ({ exe: "x", args: [], via: "direct" }));
    expect(got).toEqual(["claude", "codex", "opencode", "pi", "grok"]);
  });
});

describe("folderSuggestions", () => {
  it("去重，并按该目录上最近一次活动倒序", () => {
    const A = "C:\\a";
    const B = "C:\\b";
    const got = folderSuggestions([
      s("claude", B, "2026-08-01T00:00:00Z"),
      s("pi", A, "2026-08-10T00:00:00Z"),
      s("grok", B, "2026-08-12T00:00:00Z"), // B 的最近一次比 A 晚
      s("codex", A, "2026-08-02T00:00:00Z"),
    ]);
    expect(got).toEqual([B, A]);
  });

  it("排除工作目录已消失的会话 —— 候选是要拿去启动的", () => {
    // 与历史视图刻意不同：历史保留它们（那是回顾），候选排除（给个不存在的目录毫无意义）
    const got = folderSuggestions([
      s("claude", "C:\\gone", "2026-08-12T00:00:00Z", false),
      s("pi", "C:\\alive", "2026-08-01T00:00:00Z"),
    ]);
    expect(got).toEqual(["C:\\alive"]);
  });

  it("排除工作目录未知的会话", () => {
    expect(folderSuggestions([s("codex", null, "2026-08-12T00:00:00Z")])).toEqual([]);
  });

  it("没有可用会话时返回空列表", () => {
    expect(folderSuggestions([])).toEqual([]);
  });
});

describe("validateTarget", () => {
  it("存在的目录通过", () => {
    expect(() => validateTarget(scratch)).not.toThrow();
  });

  it("不存在的目录被拒，且错误里含那个路径", () => {
    const gone = join(scratch, "不存在的目录");
    expect(() => validateTarget(gone)).toThrow(gone);
  });

  it("拒绝时绝不创建该目录", () => {
    const gone = join(scratch, "千万别创建我");
    try {
      validateTarget(gone);
    } catch {
      /* 预期 */
    }
    // 悄悄 mkdir 然后在里面开个空会话，用户会以为自己进错了项目
    expect(existsSync(gone)).toBe(false);
  });

  it("路径存在但是文件时也拒绝", () => {
    const f = join(scratch, "这是个文件.txt");
    writeFileSync(f, "x");
    expect(() => validateTarget(f)).toThrow(/不是目录/);
  });

  it("空字符串被拒", () => {
    expect(() => validateTarget("")).toThrow();
  });
});
