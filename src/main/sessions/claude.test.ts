import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultClaudeRoot, scanClaude } from "./claude";

const scratch = mkdtempSync(join(tmpdir(), "agentory-cc-"));
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 残留无害 */
  }
});

let n = 0;
function makeRoot(): string {
  const root = join(scratch, `root-${n++}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** 真实形态：第一行是 mode（没有 cwd），cwd 出现在后面几行 */
function sessionFile(cwd: string | null, ts = "2026-08-01T10:00:00.000Z"): string {
  const lines = [JSON.stringify({ type: "mode", mode: "normal", sessionId: "x" })];
  if (cwd !== null) lines.push(JSON.stringify({ type: "user", cwd, timestamp: ts }));
  else lines.push(JSON.stringify({ type: "user", timestamp: ts }));
  return `${lines.join("\n")}\n`;
}

describe("scanClaude", () => {
  it("有损目录名不影响结果 —— cwd 取自内容", () => {
    const root = makeRoot();
    // 目录名把下划线也编码成了连字符：local_GPU → local-GPU
    const dir = join(root, "C--Users-PC-Desktop-Recent-local-GPU");
    mkdirSync(dir, { recursive: true });
    const real = "C:\\Users\\PC\\Desktop\\Recent\\local_GPU";
    writeFileSync(join(dir, "abc-123.jsonl"), sessionFile(real));

    const s = scanClaude(root).sessions[0]!;
    expect(s.cwd).toBe(real);
    expect(s.cwd).toContain("local_GPU");
    // 反解目录名会得到这个不存在的路径
    expect(s.cwd).not.toContain("local-GPU");
    expect(s.sessionId).toBe("abc-123");
  });

  it("子 agent 的 transcript 与工具输出不计为会话", () => {
    const root = makeRoot();
    const dir = join(root, "C--Users-PC");
    const side = join(dir, "abc-123", "subagents");
    mkdirSync(side, { recursive: true });
    mkdirSync(join(dir, "abc-123", "tool-results"), { recursive: true });
    mkdirSync(join(dir, "memory"), { recursive: true });

    writeFileSync(join(dir, "abc-123.jsonl"), sessionFile(scratch));
    // 这些都在子目录里，递归扫描会把它们数成会话
    writeFileSync(join(side, "agent-aaa.jsonl"), '{"isSidechain":true,"type":"user"}\n');
    writeFileSync(join(side, "agent-bbb.jsonl"), '{"isSidechain":true,"type":"user"}\n');
    writeFileSync(join(dir, "abc-123", "tool-results", "t.jsonl"), '{"x":1}\n');

    const r = scanClaude(root);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.sessionId).toBe("abc-123");
  });

  it("顶层若混进带 isSidechain 的文件，也要拦下并说明", () => {
    const root = makeRoot();
    const dir = join(root, "C--Users-PC");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-ccc.jsonl"), '{"isSidechain":true,"type":"user"}\n');

    const r = scanClaude(root);
    expect(r.sessions).toEqual([]);
    expect(r.problems[0]).toMatch(/isSidechain/);
  });

  it("读不到 cwd 的会话仍然保留，标记为 null", () => {
    const root = makeRoot();
    const dir = join(root, "C--Users-PC");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "no-cwd.jsonl"), sessionFile(null));

    const s = scanClaude(root).sessions[0]!;
    expect(s.cwd).toBeNull();
    expect(s.cwdExists).toBe(false);
    expect(s.sessionId).toBe("no-cwd");
  });

  it("cwd 超出头部窗口时当作取不到，而不是去反解目录名", () => {
    const root = makeRoot();
    const dir = join(root, "C--Users-PC");
    mkdirSync(dir, { recursive: true });
    const pad = Array.from({ length: 60 }, (_, i) => `{"type":"pad","n":${i}}`).join("\n");
    writeFileSync(join(dir, "late.jsonl"), `${pad}\n{"cwd":"C:/late","timestamp":"2026-08-01T00:00:00Z"}\n`);

    expect(scanClaude(root).sessions[0]!.cwd).toBeNull();
  });

  it("存储目录不存在时返回空列表", () => {
    expect(scanClaude(join(scratch, "没装 claude")).sessions).toEqual([]);
  });

  it("本机真实数据：会话数等于顶层 jsonl 的个数，不含子 agent", (ctx) => {
    const root = defaultClaudeRoot();
    if (!existsSync(root)) {
      ctx.skip();
      return;
    }
    // 独立数一遍顶层的 jsonl，作为对照
    let topLevel = 0;
    for (const d of readdirSync(root)) {
      const p = join(root, d);
      if (!statSync(p).isDirectory()) continue;
      for (const f of readdirSync(p)) {
        if (f.toLowerCase().endsWith(".jsonl") && statSync(join(p, f)).isFile()) topLevel++;
      }
    }
    const r = scanClaude(root);
    expect(r.sessions.length).toBe(topLevel);
    // cwd 解析率：实测 486/487，留出余量
    const withCwd = r.sessions.filter((s) => s.cwd !== null).length;
    expect(withCwd / r.sessions.length).toBeGreaterThan(0.95);
    // 真实路径必须是绝对路径
    for (const s of r.sessions) if (s.cwd) expect(s.cwd).toMatch(/^[A-Za-z]:[\\/]/);
  });
});
