import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerThemeIpc,
  summariesEnabled,
  versionCheckEnabled,
  type ThemeState,
} from "./service";

/**
 * 这个模块到今天为止一行测试都没有（136 行 / 0 行），原因是它 import 了 `electron`，
 * 而整个仓库没有一个测试 mock 过 electron —— 只 mock 过 `node:child_process` 和 `node:fs`。
 *
 * 但它**不是「主题」模块，是设置持久化模块**：摘要开关（内容出境的总闸）和
 * 版本检测开关都存在这里。零覆盖的代价是下面第一条测试里那个真实的数据丢失。
 *
 * `vi.mock` 的工厂会被提升到文件顶部，所以它引用的东西必须走 `vi.hoisted`。
 */
const el = vi.hoisted(() => ({
  userData: "",
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  prefersDark: false,
}));

vi.mock("electron", () => ({
  // `getPreferredSystemLanguages` 是 `language: "system"` 解析用的（`getLocale` 是兜底）。
  // 给一个固定的英文 locale，这样「默认设置下解析成什么」在测试里是确定的，
  // 不跟着跑测试那台机器的系统语言走。
  app: {
    getPath: (): string => el.userData,
    getLocale: (): string => "en-US",
    getPreferredSystemLanguages: (): string[] => ["en-US"],
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown): void => {
      el.handlers.set(ch, fn);
    },
  },
  nativeTheme: {
    get shouldUseDarkColors(): boolean {
      return el.prefersDark;
    },
    on: (): void => undefined,
  },
}));

/** 每个用例一个干净的 userData —— 设置文件是这一层的全部状态。 */
beforeEach(() => {
  el.userData = mkdtempSync(join(tmpdir(), "agentory-theme-"));
  el.handlers.clear();
  registerThemeIpc(() => null);
});

const setTheme = (patch: Record<string, string>): ThemeState =>
  el.handlers.get("theme:set")!(null, patch) as ThemeState;
const state = (): ThemeState => el.handlers.get("theme:state")!(null) as ThemeState;
const onDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(el.userData, "settings.json"), "utf8")) as Record<string, unknown>;

describe("开关与主题共用一份设置文件", () => {
  /**
   * **换个主题，摘要开关自己关掉了。**
   *
   * 两个写入者，一个拿磁盘当真相、一个拿内存当真相：
   * `summariesEnabled.set` 是 `writeSettings({ ...readSettings(), ... })`（读盘→写盘），
   * 而 `theme:set` 写的是模块级 `settings` 快照 —— 那个快照只在 `registerThemeIpc`
   * 时读过一次，开关的 set 从不更新它。
   *
   * 复现路径全是正常操作：开设置 → 打开摘要开关 → 点一张主题卡片。
   * 用户下次打开设置看到开关是关的，而他刚填的 API key 还在（key 在另一个文件），
   * 看起来就像「开关自己坏了」。
   */
  it("打开摘要开关之后换主题，开关不会被写回默认值", () => {
    summariesEnabled.set(true);
    expect(onDisk()["summariesEnabled"]).toBe(true);

    setTheme({ themeId: "paper" });

    expect(summariesEnabled.get()).toBe(true);
    expect(onDisk()["summariesEnabled"]).toBe(true);
  });

  /** 反向同样：版本检测默认开，关掉之后换主题不该把它开回来。 */
  it("关掉版本检测之后换主题，它不会自己开回来", () => {
    versionCheckEnabled.set(false);
    setTheme({ mode: "dark" });
    expect(versionCheckEnabled.get()).toBe(false);
    expect(onDisk()["versionCheckEnabled"]).toBe(false);
  });

  /** 反过来也要成立：改了开关不能把刚选的主题冲掉。 */
  it("换了主题之后开开关，主题不会被写回默认值", () => {
    setTheme({ themeId: "paper", mode: "light" });
    summariesEnabled.set(true);
    expect(onDisk()["themeId"]).toBe("paper");
    expect(onDisk()["mode"]).toBe("light");
    expect(state().themeId).toBe("paper");
  });
});

describe("设置文件坏了或缺了", () => {
  it("没有设置文件时用默认值：graphite / system / 摘要关 / 版本检测开", () => {
    const s = state();
    expect(s.themeId).toBe("graphite");
    expect(s.mode).toBe("system");
    expect(summariesEnabled.get()).toBe(false);
    expect(versionCheckEnabled.get()).toBe(true);
  });

  it("设置文件不是合法 JSON 时回默认值，不抛", () => {
    writeFileSync(join(el.userData, "settings.json"), "{ 这不是 json");
    expect(() => state()).not.toThrow();
    expect(state().themeId).toBe("graphite");
  });

  /**
   * 记住的主题可能来自一个已被删掉的用户主题文件。回退到默认，不是崩溃 ——
   * 而且**不能顺手把设置文件改掉**：文件删了可能只是暂时的（换台机器同步回来）。
   */
  it("记住的主题 id 不存在时回落到 graphite，且不改写设置文件", () => {
    writeFileSync(
      join(el.userData, "settings.json"),
      JSON.stringify({ themeId: "被删掉的主题", mode: "dark" }),
    );
    registerThemeIpc(() => null);
    expect(state().themeId).toBe("graphite");
    expect(onDisk()["themeId"]).toBe("被删掉的主题");
  });
});

describe("用户自定义主题目录", () => {
  it("目录里有非法 JSON 时，跳过它并在 warnings 里说清是哪个文件", () => {
    mkdirSync(join(el.userData, "themes"), { recursive: true });
    writeFileSync(join(el.userData, "themes", "坏的.json"), "{{{");
    const s = state();
    expect(s.warnings.some((w) => w.includes("坏的.json"))).toBe(true);
    // 一个坏文件不该让整个主题列表消失
    expect(s.themes.length).toBeGreaterThan(0);
  });

  it("目录不存在时不报警告 —— 那是新机器的正常状态，不是错误", () => {
    expect(state().warnings).toEqual([]);
  });
});
