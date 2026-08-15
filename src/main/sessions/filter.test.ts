import { describe, expect, it } from "vitest";
import { filterSessions } from "./filter";
import type { AgentId, Session } from "./types";

let clock = 0;
function s(agent: AgentId, cwd: string | null, title?: string): Session {
  // 倒序构造：先造的时间更晚，模拟 scanAll 已排好的输入
  clock -= 1000;
  return {
    agent,
    sessionId: `${agent}-${Math.abs(clock)}`,
    cwd,
    cwdExists: cwd !== null,
    lastActivity: new Date(Date.UTC(2026, 7, 13) + clock),
    lastActivityExact: true,
    source: "x",
    ...(title === undefined ? {} : { nativeTitle: title }),
  };
}

const LIST: Session[] = [
  s("claude", "C:\\Users\\PC\\Desktop\\Recent\\local_GPU"),
  s("opencode", "C:\\Users\\PC\\Desktop\\Recent\\KnowledgeBase", "AI项目知识库整理规划"),
  s("grok", "D:\\Projects3\\llama"),
  s("pi", "C:\\Users\\PC\\Desktop\\Recent\\ios_app_idea"),
  s("codex", null),
];

describe("filterSessions", () => {
  it("没有条件时原样返回", () => {
    expect(filterSessions(LIST, {})).toEqual(LIST);
  });

  it("文本匹配工作目录", () => {
    const r = filterSessions(LIST, { text: "local_GPU" });
    expect(r.map((x) => x.agent)).toEqual(["claude"]);
  });

  it("文本匹配原生标题", () => {
    const r = filterSessions(LIST, { text: "知识库" });
    expect(r.map((x) => x.agent)).toEqual(["opencode"]);
  });

  it("文本匹配忽略大小写", () => {
    expect(filterSessions(LIST, { text: "LOCAL_gpu" }).map((x) => x.agent)).toEqual(["claude"]);
    expect(filterSessions(LIST, { text: "projects3" }).map((x) => x.agent)).toEqual(["grok"]);
  });

  it("cwd 为 null 的会话不会因为文本匹配而崩", () => {
    expect(() => filterSessions(LIST, { text: "任意" })).not.toThrow();
    // 它没有 cwd 也没有标题，任何非空文本都匹配不上
    expect(filterSessions(LIST, { text: "c:" }).some((x) => x.agent === "codex")).toBe(false);
  });

  it("按 agent 筛选", () => {
    const r = filterSessions(LIST, { agents: ["grok", "pi"] });
    expect(r.map((x) => x.agent)).toEqual(["grok", "pi"]);
  });

  it("agents 为空数组时不筛（等同于不限制）", () => {
    expect(filterSessions(LIST, { agents: [] })).toEqual(LIST);
  });

  it("文本与 agent 同时生效，取交集", () => {
    const r = filterSessions(LIST, { text: "Recent", agents: ["pi"] });
    expect(r.map((x) => x.agent)).toEqual(["pi"]);
  });

  it("筛选不改变排序 —— 结果仍按最后活动时间倒序", () => {
    const r = filterSessions(LIST, { text: "Recent" });
    expect(r.length).toBeGreaterThan(1);
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1]!.lastActivity.getTime()).toBeGreaterThanOrEqual(r[i]!.lastActivity.getTime());
    }
  });

  it("无匹配时返回空数组 —— 界面据此区分「没结果」与「还在加载」", () => {
    expect(filterSessions(LIST, { text: "绝不存在的字符串" })).toEqual([]);
  });

  it("全是空白的文本视同没有条件", () => {
    expect(filterSessions(LIST, { text: "   " })).toEqual(LIST);
  });
});
