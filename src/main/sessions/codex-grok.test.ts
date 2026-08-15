import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultCodexRoot, scanCodex } from "./codex";
import { defaultGrokRoot, scanGrok } from "./grok";

const scratch = mkdtempSync(join(tmpdir(), "agentory-cg-"));
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 残留无害 */
  }
});

let n = 0;
const makeRoot = (): string => {
  const p = join(scratch, `root-${n++}`);
  mkdirSync(p, { recursive: true });
  return p;
};

// ---------------- Codex ----------------

/** 复刻真实形态：session_meta 在第 1 行且**不含 cwd**，cwd 在后面的 turn_context 里。 */
function codexFile(sessionId: string, cwd: string | null): string {
  const lines = [
    JSON.stringify({ timestamp: "2026-07-07T04:56:39.801Z", type: "session_meta", payload: { session_id: sessionId, id: sessionId } }),
    JSON.stringify({ timestamp: "2026-07-07T04:56:39.801Z", type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ timestamp: "2026-07-07T04:56:40.983Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions>" }] } }),
  ];
  if (cwd !== null) {
    lines.push(JSON.stringify({ timestamp: "2026-07-07T04:56:40.984Z", type: "turn_context", payload: { turn_id: "t1", cwd } }));
  }
  lines.push(JSON.stringify({ timestamp: "2026-07-08T09:00:00.000Z", type: "response_item", payload: { type: "message", role: "assistant" } }));
  return `${lines.join("\n")}\n`;
}

describe("scanCodex", () => {
  it("cwd 取自 turn_context，不是 session_meta", () => {
    const root = makeRoot();
    const dir = join(root, "2026", "07", "07");
    mkdirSync(dir, { recursive: true });
    const real = "C:\\Users\\PC\\Desktop\\Recent\\Resume\\jobs";
    writeFileSync(join(dir, "rollout-2026-07-07T04-56-39-019f3aef.jsonl"), codexFile("019f3aef", real));

    const s = scanCodex(root).sessions[0]!;
    expect(s.agent).toBe("codex");
    expect(s.sessionId).toBe("019f3aef");
    expect(s.cwd).toBe(real);
    // 最后活动取自内容里最后一条时间戳，不是第一条
    expect(s.lastActivity.toISOString()).toBe("2026-07-08T09:00:00.000Z");
    expect(s.lastActivityExact).toBe(true);
  });

  it("跨 YYYY/MM/DD 分区全部收集", () => {
    const root = makeRoot();
    for (const [y, m, d] of [["2026", "07", "07"], ["2026", "08", "01"], ["2025", "12", "31"]]) {
      const dir = join(root, y!, m!, d!);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `rollout-${y}.jsonl`), codexFile(`id-${y}-${m}`, scratch));
    }
    expect(scanCodex(root).sessions).toHaveLength(3);
  });

  it("没有 turn_context 时 cwd 是 null —— 路径里没有项目信息可用", () => {
    const root = makeRoot();
    const dir = join(root, "2026", "07", "07");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "r.jsonl"), codexFile("no-cwd", null));
    const s = scanCodex(root).sessions[0]!;
    expect(s.cwd).toBeNull();
    expect(s.cwdExists).toBe(false);
  });

  it("存储目录不存在时返回空列表", () => {
    expect(scanCodex(join(scratch, "没装 codex")).sessions).toEqual([]);
  });

  it("本机真实数据：cwd 是绝对路径或 null", (ctx) => {
    if (!existsSync(defaultCodexRoot())) return void ctx.skip();
    const r = scanCodex();
    expect(r.sessions.length).toBeGreaterThan(0);
    for (const s of r.sessions) {
      expect(s.sessionId).toBeTruthy();
      if (s.cwd !== null) expect(s.cwd).toMatch(/^[A-Za-z]:[\\/]/);
    }
  });
});

// ---------------- Grok ----------------

function grokSession(root: string, project: string, id: string, summary: object | null): void {
  const dir = join(root, project, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chat_history.jsonl"), '{"type":"system","content":"x"}\n');
  if (summary !== null) writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
}

describe("scanGrok", () => {
  it("一个会话是一个目录，cwd 与时间取自 summary.json", () => {
    const root = makeRoot();
    const real = "D:\\Projects3\\llama";
    grokSession(root, "D%3A%5CProjects3%5Cllama", "019fd3a4-aaaa", {
      info: { id: "019fd3a4-aaaa", cwd: real },
      created_at: "2026-08-05T20:36:41.507585Z",
      updated_at: "2026-08-05T20:37:33.505331600Z",
      session_summary: "skills",
    });
    const s = scanGrok(root).sessions[0]!;
    expect(s.agent).toBe("grok");
    expect(s.sessionId).toBe("019fd3a4-aaaa");
    expect(s.cwd).toBe(real);
    expect(s.lastActivityExact).toBe(true);
    expect(s.lastActivity.toISOString().slice(0, 19)).toBe("2026-08-05T20:37:33");
  });

  it("session_summary 不被采纳为标题 —— 它是粗暴截断", () => {
    const root = makeRoot();
    grokSession(root, "P", "id1", {
      info: { id: "id1", cwd: scratch },
      updated_at: "2026-08-05T20:00:00Z",
      // 真实样例：从句子中间切断，还带 BOM
      session_summary: "\ufeffUse brave web search to find out who won the",
    });
    expect(scanGrok(root).sessions[0]!.nativeTitle).toBeUndefined();
  });

  it("项目目录本身不算会话", () => {
    const root = makeRoot();
    grokSession(root, "P", "s1", { info: { id: "s1", cwd: scratch }, updated_at: "2026-08-01T00:00:00Z" });
    grokSession(root, "P", "s2", { info: { id: "s2", cwd: scratch }, updated_at: "2026-08-02T00:00:00Z" });
    const r = scanGrok(root);
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("缺 summary.json 的目录被跳过并记录", () => {
    const root = makeRoot();
    grokSession(root, "P", "broken", null);
    const r = scanGrok(root);
    expect(r.sessions).toEqual([]);
    expect(r.problems[0]).toMatch(/缺 summary\.json/);
  });

  it("summary.json 坏掉时跳过，同项目其它会话照常", () => {
    const root = makeRoot();
    grokSession(root, "P", "ok", { info: { id: "ok", cwd: scratch }, updated_at: "2026-08-01T00:00:00Z" });
    mkdirSync(join(root, "P", "bad"), { recursive: true });
    writeFileSync(join(root, "P", "bad", "summary.json"), "{ 这不是 JSON");
    const r = scanGrok(root);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["ok"]);
    expect(r.problems).toHaveLength(1);
  });

  it("存储目录不存在时返回空列表", () => {
    expect(scanGrok(join(scratch, "没装 grok")).sessions).toEqual([]);
  });

  it("本机真实数据：无一采纳 session_summary 作标题", (ctx) => {
    if (!existsSync(defaultGrokRoot())) return void ctx.skip();
    const r = scanGrok();
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.sessions.every((s) => s.nativeTitle === undefined)).toBe(true);
    for (const s of r.sessions) if (s.cwd) expect(s.cwd).toMatch(/^[A-Za-z]:[\\/]/);
  });
});
