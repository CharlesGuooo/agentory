import { describe, expect, it } from "vitest";
import { loadThemes, parseTheme, resolveVariant, toCssVars, toXtermTheme } from "./theme";

const colors = (bg: string): Record<string, unknown> => ({
  bg,
  chrome: "#1B1E25",
  line: "#262A33",
  fg: "#D6D9E0",
  dim: "#7C838F",
  cursor: "#7FB0FF",
  accent: "#7FB0FF",
  sel: "#232833",
  ansi: Array.from({ length: 16 }, (_, i) => `#${i.toString(16).repeat(6)}`),
});

const good = (id = "graphite"): Record<string, unknown> => ({
  id,
  name: id.toUpperCase(),
  dark: colors("#16181D"),
  light: colors("#FFFFFF"),
});

describe("parseTheme", () => {
  it("合法主题原样解析出来", () => {
    const t = parseTheme(good());
    expect(t.id).toBe("graphite");
    expect(t.dark.ansi).toHaveLength(16);
  });

  it("缺必需字段要抛错，且错误信息指出缺了什么", () => {
    const t = good();
    delete t["light"];
    expect(() => parseTheme(t)).toThrow(/light/);
  });

  it("ansi 长度不是 16 要被拒", () => {
    const t = good();
    (t["dark"] as Record<string, unknown>)["ansi"] = ["#000000"];
    expect(() => parseTheme(t)).toThrow(/16/);
  });

  it("颜色值不是 #rrggbb 要被拒", () => {
    const t = good();
    (t["dark"] as Record<string, unknown>)["bg"] = "red";
    expect(() => parseTheme(t)).toThrow(/bg/);
  });
});

describe("loadThemes", () => {
  it("非法主题被跳过并产生告警，其余照常加载，不抛错", () => {
    const r = loadThemes({
      builtin: [good("graphite"), good("harbor")],
      user: [{ id: "坏的", name: "坏的" }],
    });
    expect(r.themes.map((t) => t.id)).toEqual(["graphite", "harbor"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/坏的/);
  });

  it("用户主题与内置同 id 时覆盖内置", () => {
    const mine = { ...good("graphite"), name: "我改的" };
    const r = loadThemes({ builtin: [good("graphite")], user: [mine] });
    expect(r.themes).toHaveLength(1);
    expect(r.themes[0]!.name).toBe("我改的");
  });

  it("用户新增的主题追加在后面", () => {
    const r = loadThemes({ builtin: [good("graphite")], user: [good("mine")] });
    expect(r.themes.map((t) => t.id)).toEqual(["graphite", "mine"]);
  });
});

describe("resolveVariant", () => {

  it("跟随系统时取系统的明暗", () => {
    expect(resolveVariant("system", true)).toBe("dark");
    expect(resolveVariant("system", false)).toBe("light");
  });

  it("强制模式覆盖系统", () => {
    expect(resolveVariant("light", true)).toBe("light");
    expect(resolveVariant("dark", false)).toBe("dark");
  });

  it("明暗与主题身份无关：任何主题在系统深色下都取自己的 dark，不换主题", () => {
    // D-14 的核心 —— 主题与明暗正交。解析只看 mode 与系统值，
    // 主题不参与解析，所以 paper 也是拿自己的 dark 面。
    expect(resolveVariant("system", true)).toBe("dark");
  });
});

describe("toXtermTheme", () => {
  const t = parseTheme(good());

  it("16 个色槽映射到 xterm.js 的具名键", () => {
    const x = toXtermTheme(t.dark);
    expect(x["black"]).toBe(t.dark.ansi[0]);
    expect(x["white"]).toBe(t.dark.ansi[7]);
    expect(x["brightBlack"]).toBe(t.dark.ansi[8]);
    expect(x["brightWhite"]).toBe(t.dark.ansi[15]);
  });

  it("bg/fg/cursor 映射到 background/foreground/cursor", () => {
    const x = toXtermTheme(t.dark);
    expect(x["background"]).toBe("#16181D");
    expect(x["foreground"]).toBe(t.dark.fg);
    expect(x["cursor"]).toBe(t.dark.cursor);
  });

  it("不把外壳专用的颜色泄漏进终端主题", () => {
    const x = toXtermTheme(t.dark);
    for (const k of ["chrome", "line", "dim", "accent", "sel"]) {
      expect(x).not.toHaveProperty(k);
    }
  });
});

describe("toCssVars", () => {
  it("外壳颜色映射成 CSS 自定义属性", () => {
    const v = toCssVars(parseTheme(good()).dark);
    expect(v["--c-bg"]).toBe("#16181D");
    expect(v["--c-chrome"]).toBe("#1B1E25");
    expect(v["--c-accent"]).toBe("#7FB0FF");
  });
});
