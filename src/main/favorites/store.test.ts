import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addFavorite, emptyFavorites } from "./model";
import { loadFavorites, saveFavorites } from "./store";

const tmp = (): string => join(mkdtempSync(join(tmpdir(), "agentory-fav-")), "favorites.json");

const entry = {
  agent: "claude" as const,
  sessionId: "85a3eab9-262b-4b5b-bded-fa0f6ebec767",
  cwd: "C:/proj",
  label: "评估单卡 RTX PRO 6000 跑 DeepSeek V4 的可行性",
  addedAt: "2026-08-14T02:00:00.000Z",
};

describe("收藏夹落盘", () => {
  it("写进去读回来一致", () => {
    const p = tmp();
    saveFavorites(p, addFavorite(emptyFavorites(), entry));
    expect(loadFavorites(p).favorites.sessions).toEqual([entry]);
  });

  it("文件不存在返回空，且不算错误", () => {
    const r = loadFavorites(tmp());
    expect(r.favorites.sessions).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("落盘带缩进 —— 用户应该能直接打开手改", () => {
    const p = tmp();
    saveFavorites(p, addFavorite(emptyFavorites(), entry));
    expect(readFileSync(p, "utf8")).toContain('\n  "sessions"');
  });

  /**
   * 与工作集共用同一层外壳（D-F5）。这条测试存在的意义是证明**共用是真的** ——
   * 如果哪天有人把校验复制成两份，工作集那边的测试仍会绿，而这条会红。
   */
  it("坏 JSON → 空 + 告警，且**绝不写回**", () => {
    const p = tmp();
    const junk = "{ 这不是 JSON";
    writeFileSync(p, junk);

    const r = loadFavorites(p);
    expect(r.favorites.sessions).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    // 读回原文件比对 —— 读不动就把它抹了，等于替用户销毁记录
    expect(readFileSync(p, "utf8")).toBe(junk);
  });

  it("单条坏掉只跳过那条，其余保留", () => {
    const p = tmp();
    writeFileSync(
      p,
      JSON.stringify({ version: 1, sessions: [entry, { agent: "不存在的agent" }, entry] }),
    );
    const r = loadFavorites(p);
    // 第三条与第一条是同一个主键，但 store 只负责读，去重是 model 的事
    expect(r.favorites.sessions).toHaveLength(2);
    expect(r.warnings).toHaveLength(1);
  });

  /** D-F3：没有 sessionId 的不是一条有效收藏 —— 「以后还要用这个」必须指向那一个。 */
  it("缺 sessionId 的条目被拒，并说清楚为什么", () => {
    const p = tmp();
    const { sessionId: _drop, ...noId } = entry;
    writeFileSync(p, JSON.stringify({ version: 1, sessions: [noId] }));
    const r = loadFavorites(p);
    expect(r.favorites.sessions).toEqual([]);
    expect(r.warnings[0]).toContain("sessionId");
  });

  it("没有 label 的条目照样能读回来 —— 预览取不到是正常情况", () => {
    const p = tmp();
    const { label: _drop, ...noLabel } = entry;
    writeFileSync(p, JSON.stringify({ version: 1, sessions: [noLabel] }));
    const r = loadFavorites(p);
    expect(r.favorites.sessions).toEqual([noLabel]);
    expect(r.warnings).toEqual([]);
  });
});
