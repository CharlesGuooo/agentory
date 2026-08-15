import { describe, expect, it } from "vitest";
import { scanAll, type Scanner } from "./scan";
import type { ScanResult, Session } from "./types";

const at = (iso: string): Date => new Date(iso);

function session(over: Partial<Session> = {}): Session {
  return {
    agent: "claude",
    sessionId: "s1",
    cwd: "C:\\x",
    cwdExists: true,
    lastActivity: at("2026-08-01T00:00:00Z"),
    lastActivityExact: true,
    source: "C:\\x\\s1.jsonl",
    ...over,
  };
}

const ok = (sessions: Session[], problems: string[] = []): ScanResult => ({ sessions, problems });
const scanner = (agent: Session["agent"], run: () => ScanResult): Scanner => ({ agent, run });

describe("Session 的形状约束", () => {
  it("cwd 取不到时是 null —— 不得是空串，也不得是伪造路径", () => {
    const s = session({ cwd: null, cwdExists: false });
    expect(s.cwd).toBeNull();
    // 这条断言存在的意义：空串会被下游当成"有值"，从而拼出错误的路径
    expect(s.cwd).not.toBe("");
  });

  it("cwd 为 null 时 cwdExists 必须是 false", () => {
    const r = scanAll([scanner("pi", () => ok([session({ cwd: null, cwdExists: true })]))]);
    // 合并层负责纠正这个不一致，而不是把矛盾状态传给下游
    expect(r.sessions[0]!.cwdExists).toBe(false);
  });
});

describe("scanAll", () => {
  it("按最后活动时间倒序合并", () => {
    const r = scanAll([
      scanner("claude", () => ok([session({ sessionId: "老", lastActivity: at("2026-08-01T00:00:00Z") })])),
      scanner("grok", () => ok([session({ agent: "grok", sessionId: "新", lastActivity: at("2026-08-13T00:00:00Z") })])),
      scanner("pi", () => ok([session({ agent: "pi", sessionId: "中", lastActivity: at("2026-08-07T00:00:00Z") })])),
    ]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["新", "中", "老"]);
  });

  it("一个 agent 抛错，其余四个照常返回，错误被带出来", () => {
    const r = scanAll([
      scanner("claude", () => ok([session()])),
      scanner("codex", () => {
        throw new Error("存储目录读不动");
      }),
      scanner("opencode", () => ok([session({ agent: "opencode", sessionId: "oc" })])),
    ]);
    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual(["oc", "s1"]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/codex/);
    expect(r.problems[0]).toMatch(/存储目录读不动/);
  });

  it("各扫描器自己报的问题被汇总，且标明来自哪个 agent", () => {
    const r = scanAll([
      scanner("claude", () => ok([session()], ["a.jsonl 不是合法 JSONL"])),
      scanner("grok", () => ok([], ["b/summary.json 缺 info.cwd"])),
    ]);
    expect(r.problems).toHaveLength(2);
    expect(r.problems.some((p) => p.includes("claude") && p.includes("a.jsonl"))).toBe(true);
    expect(r.problems.some((p) => p.includes("grok") && p.includes("summary.json"))).toBe(true);
  });

  it("全部 agent 都没装时返回空列表而不是抛错", () => {
    const r = scanAll([scanner("claude", () => ok([])), scanner("pi", () => ok([]))]);
    expect(r.sessions).toEqual([]);
    expect(r.problems).toEqual([]);
  });

  it("同一 agent 内的会话也参与全局排序，不是按 agent 分块", () => {
    const r = scanAll([
      scanner("claude", () => ok([
        session({ sessionId: "c1", lastActivity: at("2026-08-10T00:00:00Z") }),
        session({ sessionId: "c2", lastActivity: at("2026-08-02T00:00:00Z") }),
      ])),
      scanner("pi", () => ok([
        session({ agent: "pi", sessionId: "p1", lastActivity: at("2026-08-05T00:00:00Z") }),
      ])),
    ]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["c1", "p1", "c2"]);
  });
});
