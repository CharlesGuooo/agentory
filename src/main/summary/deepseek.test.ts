import { describe, expect, it } from "vitest";
import { scanAllAgents } from "../sessions/all";
import { MODEL, PRICE, parseBilingual, summarize } from "./deepseek";
import { buildPayload, renderPayload } from "./payload";

/**
 * 双语解析。**这一条不需要 key，所以永远会跑** —— 而它守的是这一刀里
 * 最贵的那个失败：一条只有一半语言、或者被半个 JSON 拼出来的记录写进缓存，
 * `sourceLastActivity` 会让它**永远不再重摘**。
 */
describe("从模型回复里抠出双语", () => {
  it("正常的 JSON", () => {
    expect(parseBilingual('{"zh":"改了装机清单","en":"changed the build list"}')).toEqual({
      zh: "改了装机清单",
      en: "changed the build list",
    });
  });

  it("裹了 markdown 代码围栏也认", () => {
    const raw = '```json\n{"zh":"甲","en":"alpha"}\n```';
    expect(parseBilingual(raw)).toEqual({ zh: "甲", en: "alpha" });
  });

  it("前后有多余的话也认 —— 取第一个 { 到最后一个 }", () => {
    expect(parseBilingual('好的：{"zh":"甲","en":"alpha"} 以上')).toEqual({ zh: "甲", en: "alpha" });
  });

  it.each([
    ["不是 JSON", "就是一句普通的话"],
    ["坏 JSON", '{"zh":"甲","en":'],
    ["缺 en", '{"zh":"甲"}'],
    ["缺 zh", '{"en":"alpha"}'],
    ["en 是空串", '{"zh":"甲","en":""}'],
    ["zh 只有空白", '{"zh":"   ","en":"alpha"}'],
    ["空回复", ""],
  ])("%s → null（整条不采用，绝不写半条进缓存）", (_名, raw) => {
    expect(parseBilingual(raw)).toBeNull();
  });
});

/**
 * 真机调用一次。
 *
 * **没有 key 就跳过，不 mock。** mock 出来的「成功」只能证明我们理解的接口，
 * 证明不了 DeepSeek 真的这么回 —— 而这一刀里最容易错的恰恰是接口本身
 * （模型别名 2026-07-24 刚弃用过一批，思考模式默认开着）。
 *
 * 要跑它：`DEEPSEEK_API_KEY=sk-... npx vitest run src/main/summary/deepseek.test.ts`
 */
describe("真机调用 DeepSeek", () => {
  it(
    "真的摘出一句话，并报出真实用量",
    async (ctx) => {
      const key = process.env["DEEPSEEK_API_KEY"];
      if (!key) return void ctx.skip();

      const s = scanAllAgents().sessions.find((x) => x.agent === "claude" && x.cwd !== null);
      if (!s) return void ctx.skip();

      const p = buildPayload(s);
      const r = await summarize(renderPayload(p), key);

      if (!r.ok) throw new Error(`调用失败：${r.error}`);
      // 双语：两段都得有，而且**说的必须不是同一串字符** ——
      // 模型偷懒把中文原样填进 en 的话，切语言等于没切
      expect(r.text.zh.length).toBeGreaterThan(5);
      expect(r.text.en.length).toBeGreaterThan(5);
      expect(r.text.en).not.toBe(r.text.zh);
      expect(r.model).toBe(MODEL);

      const cost =
        (r.usage.input * PRICE.in) / 1e6 + (r.usage.output * PRICE.out) / 1e6;
      console.log(
        `\n  摘要：${r.text}\n` +
          `  用量：输入 ${r.usage.input} · 输出 ${r.usage.output} token\n` +
          `  这一条花了 $${cost.toFixed(6)}（价格查证于 ${PRICE.checkedAt}）\n` +
          `  载荷 ${p.bytes} 字节\n`,
      );
    },
    90_000,
  );
});
