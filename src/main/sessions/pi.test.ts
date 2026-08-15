import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultPiRoot, scanPi } from "./pi";

const scratch = mkdtempSync(join(tmpdir(), "agentory-pi-"));
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 残留无害 */
  }
});

/** 造一个 Pi 的存储目录。目录名故意用有损编码的形式。 */
function makeRoot(name: string, files: Array<[string, string]>): string {
  const root = join(scratch, name);
  // Pi 的真实目录名形如 --C--Users-PC-Desktop-Recent-ios_app_idea--
  const dir = join(root, "--C--Users-PC-Desktop-Recent-ios_app_idea--");
  mkdirSync(dir, { recursive: true });
  for (const [f, content] of files) writeFileSync(join(dir, f), content);
  return root;
}

const header = (id: string, cwd: string): string =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-03T23:04:11.323Z", cwd });

describe("scanPi", () => {
  it("从第一行 header 取 id 与真实 cwd", () => {
    const root = makeRoot("a", [
      [
        "2026-06-03T23-04-11_019e8fba.jsonl",
        `${header("019e8fba-aaaa", scratch)}\n{"type":"message","timestamp":"2026-06-04T01:00:00Z"}\n`,
      ],
    ]);
    const r = scanPi(root);
    expect(r.problems).toEqual([]);
    const s = r.sessions[0]!;
    expect(s.agent).toBe("pi");
    // id 取自 header，不是从文件名切出来的
    expect(s.sessionId).toBe("019e8fba-aaaa");
    expect(s.cwd).toBe(scratch);
    expect(s.cwdExists).toBe(true);
    expect(s.lastActivity.toISOString()).toBe("2026-06-04T01:00:00.000Z");
    expect(s.lastActivityExact).toBe(true);
  });

  it("绝不反解目录名 —— 有损编码的目录名不影响结果", () => {
    // 目录名里的 ios_app_idea 若被反解会变成 ios-app-idea，指向不存在的路径
    const real = "C:\\Users\\PC\\Desktop\\Recent\\ios_app_idea";
    const root = makeRoot("b", [["s.jsonl", `${header("id-b", real)}\n`]]);
    const s = scanPi(root).sessions[0]!;
    expect(s.cwd).toBe(real);
    expect(s.cwd).toContain("ios_app_idea");
    expect(s.cwd).not.toContain("ios-app-idea");
  });

  it("cwd 指向已删除目录时保留会话并标记不存在", () => {
    const gone = join(scratch, "没有这个目录");
    const root = makeRoot("c", [["s.jsonl", `${header("id-c", gone)}\n`]]);
    const s = scanPi(root).sessions[0]!;
    expect(s.cwd).toBe(gone);
    expect(s.cwdExists).toBe(false);
  });

  it("header 里没有 cwd 时是 null，不是空串", () => {
    const root = makeRoot("d", [
      ["s.jsonl", `${JSON.stringify({ type: "session", id: "id-d" })}\n`],
    ]);
    const s = scanPi(root).sessions[0]!;
    expect(s.cwd).toBeNull();
    expect(s.cwdExists).toBe(false);
  });

  it("坏文件被跳过并记录原因，同目录其它会话照常返回", () => {
    const root = makeRoot("e", [
      ["good.jsonl", `${header("ok", scratch)}\n`],
      ["broken.jsonl", "这不是 JSON\n"],
      ["empty.jsonl", ""],
    ]);
    const r = scanPi(root);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["ok"]);
    expect(r.problems).toHaveLength(2);
    expect(r.problems.some((p) => p.includes("broken.jsonl"))).toBe(true);
    expect(r.problems.some((p) => p.includes("empty.jsonl") && p.includes("空文件"))).toBe(true);
  });

  it("第一行不是 session header 的文件被跳过", () => {
    const root = makeRoot("f", [["odd.jsonl", '{"type":"message"}\n']]);
    const r = scanPi(root);
    expect(r.sessions).toEqual([]);
    expect(r.problems[0]).toMatch(/不是 session header/);
  });

  it("存储目录不存在时返回空列表，不抛错", () => {
    const r = scanPi(join(scratch, "根本没装 pi"));
    expect(r.sessions).toEqual([]);
    expect(r.problems).toEqual([]);
  });

  it("本机真实数据：每条都有 id，cwd 要么是绝对路径要么是 null", (ctx) => {
    if (!existsSync(defaultPiRoot())) {
      ctx.skip();
      return;
    }
    const r = scanPi();
    expect(r.sessions.length).toBeGreaterThan(0);
    for (const s of r.sessions) {
      expect(s.sessionId).toBeTruthy();
      if (s.cwd !== null) expect(s.cwd).toMatch(/^[A-Za-z]:[\\/]/);
    }
  });
});
