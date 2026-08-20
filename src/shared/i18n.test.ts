import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allEntries, getLang, langOfLocale, setLang, t } from "./i18n";

/** 汉字。用它扫 DOM / 文件比逐条比对文案可靠得多 —— 漏一条就红。 */
const CJK = /[一-龥]/;

describe("文案表", () => {
  /**
   * **这条是防「翻一半」的第一道。**
   *
   * 少一边不会退回中文，而是英文用户在英文界面里撞到一句中文 ——
   * 那种缺口靠肉眼是发现不了的，280 个 key 更不可能靠人一条条看。
   */
  it("每个 key 中英两种都非空", () => {
    const bad: string[] = [];
    for (const [key, v] of allEntries()) {
      if (!v.zh || !v.zh.trim()) bad.push(`${key} 缺中文`);
      if (!v.en || !v.en.trim()) bad.push(`${key} 缺英文`);
    }
    expect(bad, bad.join("；")).toEqual([]);
  });

  /** 英文那一边不该混进汉字 —— 那通常是复制粘贴时漏改了。 */
  it("英文文案里没有汉字", () => {
    const bad = allEntries()
      .filter(([, v]) => CJK.test(v.en))
      // 「中文」「English」这两个语言名是**故意**两边都一样的：
      // 一个英文用户要能认出哪一项是中文，写成 "Chinese" 反而更难认
      .filter(([key]) => key !== "set.langZh" && key !== "set.langEn")
      .map(([key, v]) => `${key}: ${v.en}`);
    expect(bad, bad.join("；")).toEqual([]);
  });

  it("插值占位在两种语言里是同一套", () => {
    const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/gu)].map((m) => m[1]!).sort();
    const bad: string[] = [];
    for (const [key, v] of allEntries()) {
      const a = holes(v.zh).join(",");
      const b = holes(v.en).join(",");
      // 漏一个占位符，界面上就会出现一句缺了数字的话 —— 而且只在那一种语言下出现
      if (a !== b) bad.push(`${key}: zh[${a}] vs en[${b}]`);
    }
    expect(bad, bad.join("；")).toEqual([]);
  });
});

describe("t()", () => {
  it("按当前语言取，切换立刻生效", () => {
    setLang("zh");
    expect(t("side.newSession")).toBe("新建会话");
    setLang("en");
    expect(t("side.newSession")).toBe("New session");
    setLang("zh");
  });

  it("插值把 {名字} 换掉", () => {
    setLang("zh");
    expect(t("side.running", { n: 3 })).toBe("3 个在跑");
    setLang("en");
    expect(t("side.running", { n: 3 })).toBe("3 running");
    setLang("zh");
  });

  /** 漏传的占位原样留着 —— 留成 `{n}` 一眼看得见，换成空字符串就查不出来了。 */
  it("漏传的占位保持原样，不静默变成空", () => {
    setLang("zh");
    expect(t("side.running")).toBe("{n} 个在跑");
  });
});

describe("系统语言解析", () => {
  it("zh 开头的都算中文，其余英文", () => {
    for (const l of ["zh", "zh-CN", "zh-TW", "zh-Hans-CN", "ZH-cn"]) {
      expect(langOfLocale(l), l).toBe("zh");
    }
    for (const l of ["en-US", "ja-JP", "de", "", "x"]) {
      expect(langOfLocale(l), l).toBe("en");
    }
  });

  it("getLang 反映最后一次 setLang", () => {
    setLang("en");
    expect(getLang()).toBe("en");
    setLang("zh");
    expect(getLang()).toBe("zh");
  });
});

/**
 * **这条是防「翻一半」的第二道，也是唯一挡得住「以后新加的按钮又写死中文」的那道。**
 *
 * 单测只能证明字典里已有的 key 是全的，证明不了「有没有漏掉的串」。
 * 而 `index.html` 是最容易随手写死文案的地方 —— 直接扫文件。
 */
describe("index.html 里不许再有写死的中文", () => {
  it("去掉注释之后一个汉字都没有", () => {
    const html = readFileSync(join(import.meta.dirname, "../renderer/index.html"), "utf8");
    // 注释里的中文是给维护者看的，留着；把它们替换成等长空白以保住行号
    const noComments = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
    const bad = noComments
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => CJK.test(line))
      .map(([n, line]) => `${n}: ${line.trim()}`);
    expect(bad, `写死的中文（该用 data-i18n）：\n${bad.join("\n")}`).toEqual([]);
  });
});
