import { describe, expect, it } from "vitest";
import { scanAllAgents } from "../sessions/all";
import { MODEL, PRICE, summarize } from "./deepseek";
import { buildPayload, renderPayload } from "./payload";

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
      expect(r.text.length).toBeGreaterThan(5);
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
