import { describe, expect, it } from "vitest";
import {
  addEntry,
  emptyWorkspace,
  entryKey,
  hasEntry,
  removeEntry,
  type WorkspaceEntry,
} from "./model";

const e = (agent: WorkspaceEntry["agent"], id: string, cwd = "C:/x"): WorkspaceEntry => ({
  agent,
  sessionId: id,
  cwd,
  addedAt: "2026-08-13T10:00:00.000Z",
});

describe("工作集成员资格", () => {
  it("新建的工作集是空的", () => {
    expect(emptyWorkspace().sessions).toEqual([]);
  });

  it("加入后成为成员", () => {
    const ws = addEntry(emptyWorkspace(), e("claude", "s1"));
    expect(ws.sessions).toHaveLength(1);
    expect(hasEntry(ws, "claude", "s1", "C:/x")).toBe(true);
  });

  it("(agent, sessionId) 是主键 —— 重复加入不产生副本", () => {
    let ws = addEntry(emptyWorkspace(), e("claude", "s1", "C:/old"));
    ws = addEntry(ws, { ...e("claude", "s1", "C:/new"), addedAt: "2026-08-14T00:00:00.000Z" });
    expect(ws.sessions).toHaveLength(1);
    // 保留最早的加入时间 —— 它记的是"什么时候进的工作集"，不是"最后一次被点"
    expect(ws.sessions[0]!.addedAt).toBe("2026-08-13T10:00:00.000Z");
  });

  it("没有 id 时按工作目录区分 —— 同一 agent 在两个目录各新建一个是两条", () => {
    // 新建的会话没有 id。若主键只看 (agent, sessionId)，第二条会被误当成重复而丢掉。
    let ws = addEntry(emptyWorkspace(), { ...e("claude", "x"), sessionId: null, cwd: "C:/a" });
    ws = addEntry(ws, { ...e("claude", "x"), sessionId: null, cwd: "C:/b" });
    expect(ws.sessions).toHaveLength(2);
  });

  it("没有 id 且同目录时才算同一条", () => {
    let ws = addEntry(emptyWorkspace(), { ...e("claude", "x"), sessionId: null, cwd: "C:/a" });
    ws = addEntry(ws, { ...e("claude", "x"), sessionId: null, cwd: "C:/a" });
    expect(ws.sessions).toHaveLength(1);
  });

  it("同 id 不同 agent 是两个不同的成员", () => {
    let ws = addEntry(emptyWorkspace(), e("claude", "same"));
    ws = addEntry(ws, e("pi", "same"));
    expect(ws.sessions).toHaveLength(2);
  });

  it("移出后不再是成员", () => {
    let ws = addEntry(emptyWorkspace(), e("claude", "s1"));
    ws = removeEntry(ws, "claude", "s1", "C:/x");
    expect(ws.sessions).toEqual([]);
    expect(hasEntry(ws, "claude", "s1", "C:/x")).toBe(false);
  });

  it("移出不存在的成员不报错，也不改变其它成员", () => {
    const ws = addEntry(emptyWorkspace(), e("claude", "s1"));
    const after = removeEntry(ws, "grok", "根本没有", "C:/x");
    expect(after.sessions).toHaveLength(1);
  });

  it("操作不修改原对象 —— 便于比较前后差异", () => {
    const before = addEntry(emptyWorkspace(), e("claude", "s1"));
    const snapshot = JSON.stringify(before);
    addEntry(before, e("pi", "s2"));
    removeEntry(before, "claude", "s1", "C:/x");
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("D-5 的核心：成员资格与运行状态正交", () => {
  it("条目里根本没有运行状态字段 —— 进程退出不可能改变成员资格", () => {
    const entry = addEntry(emptyWorkspace(), e("claude", "s1")).sessions[0]!;
    // 不是"记得不去改它"，而是结构上就没有可改的东西
    expect(Object.keys(entry).sort()).toEqual(["addedAt", "agent", "cwd", "sessionId"]);
  });

  it("不含 lastActivity / nativeTitle 这类会过期的索引字段（D-W1）", () => {
    const entry = addEntry(emptyWorkspace(), e("claude", "s1")).sessions[0]!;
    expect(entry).not.toHaveProperty("lastActivity");
    expect(entry).not.toHaveProperty("nativeTitle");
    expect(entry).not.toHaveProperty("cwdExists");
  });

  it("记录的字段足以生成恢复命令", () => {
    const entry = addEntry(emptyWorkspace(), e("codex", "abc", "C:/proj")).sessions[0]!;
    // resumeCommand 要的就是这三样
    expect(entry.agent).toBe("codex");
    expect(entry.sessionId).toBe("abc");
    expect(entry.cwd).toBe("C:/proj");
  });

  /**
   * 主键会被写进 DOM 属性（`data-key` / `data-end`），再读回来做查找。
   *
   * 这条测试是被一个真 bug 逼出来的：分隔符原本用 U+0000，
   * 而 HTML 属性解析会把 U+0000 改写成 U+FFFD ——
   * 实测（Electron 43 渲染进程）写进去 charCode 0，读回来是 65533。
   * 于是每一次按 key 的查找都对不上，而且**一声不响**：
   * ✕ 结束会话、点未启动的成员启动、切标签页、恢复面板单行勾选，四个交互全成了哑的。
   */
  it("主键不含控制字符 —— 否则进 DOM 属性会被改写", () => {
    const keys = [
      entryKey(e("claude", "s1")),
      entryKey({ ...e("claude", "s1"), sessionId: null }),
    ];
    for (const k of keys) {
      expect([...k].filter((ch) => ch.charCodeAt(0) < 0x20)).toEqual([]);
    }
  });
});
