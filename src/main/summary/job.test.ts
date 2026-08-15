import { describe, expect, it } from "vitest";
import { isStale, summaryKey, type SummaryEntry } from "./cache";
import { pending } from "./job";
import type { Session } from "../sessions/types";

const sess = (id: string, at: string, agent: Session["agent"] = "claude"): Session => ({
  agent,
  sessionId: id,
  cwd: "C:/x",
  cwdExists: true,
  lastActivity: new Date(at),
  lastActivityExact: true,
  source: "C:/x/" + id,
});

const cached = (id: string, at: string, agent: Session["agent"] = "claude"): SummaryEntry => ({
  agent,
  sessionId: id,
  text: "做了一件事",
  model: "deepseek-v4-flash",
  at: "2026-08-01T00:00:00.000Z",
  sourceLastActivity: at,
});

const cache = (...es: SummaryEntry[]): Map<string, SummaryEntry> =>
  new Map(es.map((e) => [summaryKey(e.agent, e.sessionId), e]));

describe("待办的选取（D-13：用结果本身表示进度，不建作业队列）", () => {
  it("没缓存过的都要做", () => {
    const todo = pending([sess("a", "2026-08-01"), sess("b", "2026-08-01")], cache());
    expect(todo.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  /** 续做 = 「列出还没有缓存的，接着做」。天然幂等、天然可续、崩溃安全。 */
  it("已缓存且没过期的跳过 —— 这就是「可续」的全部实现", () => {
    const todo = pending(
      [sess("a", "2026-08-01"), sess("b", "2026-08-01")],
      cache(cached("a", "2026-08-01")),
    );
    expect(todo.map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("会话又动过就要重摘", () => {
    const todo = pending([sess("a", "2026-08-05")], cache(cached("a", "2026-08-01")));
    expect(todo.map((s) => s.sessionId)).toEqual(["a"]);
  });

  /** D-7：OpenCode 自带的 title 质量已经很好，花钱重做一遍是浪费。 */
  it("opencode 一律跳过 —— 它自带的标题比我们生成的还好", () => {
    const todo = pending([sess("a", "2026-08-01", "opencode"), sess("b", "2026-08-01")], cache());
    expect(todo.map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("同一个 id 不同 agent 是两条", () => {
    const todo = pending(
      [sess("a", "2026-08-01", "claude"), sess("a", "2026-08-01", "codex")],
      cache(cached("a", "2026-08-01", "claude")),
    );
    expect(todo.map((s) => s.agent)).toEqual(["codex"]);
  });
});

describe("过期判定", () => {
  it("会话时间更新就是过期", () => {
    expect(isStale(cached("a", "2026-08-01"), new Date("2026-08-02"))).toBe(true);
  });
  it("时间没变就不过期", () => {
    expect(isStale(cached("a", "2026-08-01"), new Date("2026-08-01"))).toBe(false);
  });
});
