import { describe, expect, it } from "vitest";
import builtin from "./builtin-themes.json";
import { loadThemes, parseTheme } from "./theme";

// 这份 JSON 是从 DESIGN.md 附录 A 程序化提取的（240 个色值，手抄必错）。
// 这些测试守住它和规格的一致性。
describe("内置主题", () => {
  it("五套齐全，顺序与 D-14 一致", () => {
    const r = loadThemes({ builtin, user: [] });
    expect(r.warnings).toEqual([]);
    expect(r.themes.map((t) => t.id)).toEqual([
      "graphite",
      "harbor",
      "ember",
      "paper",
      "phosphor",
    ]);
  });

  it("每套的深浅两组都通过解析", () => {
    for (const raw of builtin) {
      const t = parseTheme(raw);
      expect(t.dark.ansi, `${t.id} 的 dark`).toHaveLength(16);
      expect(t.light.ansi, `${t.id} 的 light`).toHaveLength(16);
    }
  });

  it("默认主题 graphite 在列，且排第一", () => {
    expect(parseTheme(builtin[0]!).id).toBe("graphite");
  });
});
