import { describe, expect, it } from "vitest";
import { addFavorite, emptyFavorites, favoriteKey, hasFavorite, removeFavorite } from "./model";
import type { FavoriteEntry } from "./model";

const f = (
  agent: FavoriteEntry["agent"],
  sessionId: string,
  cwd = "C:/x",
  label?: string,
): FavoriteEntry => ({
  agent,
  sessionId,
  cwd,
  ...(label === undefined ? {} : { label }),
  addedAt: "2026-08-14T02:00:00.000Z",
});

describe("收藏夹的成员资格", () => {
  it("新建的收藏夹是空的", () => {
    expect(emptyFavorites().sessions).toEqual([]);
  });

  it("收藏后成为成员", () => {
    const fav = addFavorite(emptyFavorites(), f("claude", "s1"));
    expect(fav.sessions).toHaveLength(1);
    expect(hasFavorite(fav, "claude", "s1")).toBe(true);
  });

  it("重复收藏不产生副本，且保留最早的 addedAt", () => {
    const once = addFavorite(emptyFavorites(), f("claude", "s1"));
    const twice = addFavorite(once, { ...f("claude", "s1"), addedAt: "2026-09-01T00:00:00.000Z" });
    expect(twice.sessions).toHaveLength(1);
    expect(twice.sessions[0]!.addedAt).toBe("2026-08-14T02:00:00.000Z");
  });

  /**
   * 与 `WorkspaceEntry` 的关键差别（D-F3）：工作集条目可以是「该目录下最近的会话」，
   * 收藏**一定指向一个具体会话** —— 所以主键不需要工作集那套 `?? cwd` 兜底，
   * 同一个会话即使换了目录记录也还是同一条。
   */
  it("主键只看 (agent, sessionId) —— 同 id 不同 cwd 是同一条", () => {
    const a = addFavorite(emptyFavorites(), f("claude", "s1", "C:/one"));
    const b = addFavorite(a, f("claude", "s1", "C:/two"));
    expect(b.sessions).toHaveLength(1);
  });

  it("同 id 不同 agent 是两条", () => {
    const a = addFavorite(emptyFavorites(), f("claude", "s1"));
    const b = addFavorite(a, f("codex", "s1"));
    expect(b.sessions).toHaveLength(2);
  });

  it("取消收藏后不再是成员", () => {
    const a = addFavorite(emptyFavorites(), f("claude", "s1"));
    const b = removeFavorite(a, "claude", "s1");
    expect(hasFavorite(b, "claude", "s1")).toBe(false);
    expect(b.sessions).toEqual([]);
  });

  it("取消不存在的收藏不报错，也不动其它条目", () => {
    const a = addFavorite(emptyFavorites(), f("claude", "s1"));
    expect(removeFavorite(a, "codex", "nope").sessions).toHaveLength(1);
  });

  it("操作不修改原对象", () => {
    const a = emptyFavorites();
    addFavorite(a, f("claude", "s1"));
    expect(a.sessions).toEqual([]);
  });

  /**
   * D-F6 / D-W4：主键要写进 `data-key` 再读回来查找。
   * 上一刀里分隔符用 U+0000，被 HTML 属性解析改写成 U+FFFD，
   * 让四个交互**一声不响**地全部失效。收藏这一刀新增两条这类路径。
   */
  it("主键不含控制字符 —— 否则进 DOM 属性会被改写", () => {
    const k = favoriteKey(f("claude", "85a3eab9-262b-4b5b-bded-fa0f6ebec767"));
    expect([...k].filter((ch) => ch.charCodeAt(0) < 0x20)).toEqual([]);
  });
});
