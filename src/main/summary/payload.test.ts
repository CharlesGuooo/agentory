import { describe, expect, it } from "vitest";
import { scanAllAgents } from "../sessions/all";
import { readTail } from "../sessions/jsonl";
import { buildPayload, MSG_MAX_CHARS, TOTAL_MAX_BYTES } from "./payload";

const all = scanAllAgents().sessions.filter((s) => s.cwd !== null);

describe("摘要载荷", () => {
  /**
   * 不断言「每一条都有开头」—— 第 0 层的实测提取率是 90.5%，总有取不到的。
   * 断言的是**大多数会话两头都拿得到**，并把真实分布打出来。
   */
  it("大多数会话的首条 prompt 与尾部都拿得到", () => {
    const sample = all.slice(0, 60);
    let head = 0;
    let tail = 0;
    for (const s of sample) {
      const p = buildPayload(s);
      if (p.head !== null) head++;
      if (p.tail.length > 0) tail++;
    }
    console.log(
      `
  ${sample.length} 条样本：有开头 ${head} 条（${Math.round((head / sample.length) * 100)}%），` +
        `有尾部 ${tail} 条（${Math.round((tail / sample.length) * 100)}%）
`,
    );
    expect(head / sample.length).toBeGreaterThan(0.6);
    expect(tail / sample.length).toBeGreaterThan(0.6);
  }, 60_000);

  it("整体不超过 4 KB，单条不超过 500 字", () => {
    let checked = 0;
    for (const s of all.slice(0, 40)) {
      const p = buildPayload(s);
      expect(p.bytes).toBeLessThanOrEqual(TOTAL_MAX_BYTES);
      for (const m of p.tail) expect(m.text.length).toBeLessThanOrEqual(MSG_MAX_CHARS);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  /**
   * **这一条是这个功能能不能存在的前提。**
   *
   * 实测尾部 56% 是工具行，而**用户的源码就藏在 `tool_result` 里**。
   * 把它发给第三方模型是这个产品最不能犯的错误。
   *
   * 断言方式不是「载荷里没有 tool_result 这个词」—— 那既太弱又**会误报**：
   * 用户完全可能在对话里谈论 tool_result 这个概念（这个仓库自己的开发会话就是如此，
   * 第一版断言正是被它判红的）。
   *
   * 真正的断言是：**从原始尾部里挖一段真实的工具输出内容，断言它不在载荷里**。
   * 同时先确认原始尾部里确实有工具输出，否则这条测试就是在空转。
   */
  it("工具输出的内容一个字都不会进载荷", () => {
    let proved = 0;
    for (const s of all.filter((x) => x.agent === "claude").slice(0, 30)) {
      const raw = readTail(s.source, 512 * 1024).text;
      if (!raw.includes("tool_result")) continue;

      // 从一条真实的 tool_result 里挖一段有辨识度的内容
      const m = /"tool_result"[\s\S]{0,200}?"content"\s*:\s*"((?:[^"\\]|\\.){80,200})"/.exec(raw);
      if (!m?.[1]) continue;
      const secret = m[1].slice(20, 70);
      if (secret.length < 30) continue;

      const p = buildPayload(s);
      const text = [p.head ?? "", ...p.tail.map((x) => x.text)].join("\n");
      expect(text).not.toContain(secret);
      proved++;
      if (proved >= 5) break;
    }
    // 一次都没验到就是这条测试在空转 —— 明说，不假装通过
    expect(proved, "没有找到含工具输出的会话，这条测试没有真正验到东西").toBeGreaterThan(0);
    console.log(`\n  在 ${proved} 条真实会话上验证：工具输出的内容没有进入载荷\n`);
  }, 60_000);

  it("系统注入的那些包装消息不会进载荷", () => {
    for (const s of all.slice(0, 30)) {
      const p = buildPayload(s);
      const text = [p.head ?? "", ...p.tail.map((x) => x.text)].join("\n");
      for (const mark of ["<system-reminder", "<user_info>", "<command-", "<recommended_plugins"]) {
        expect(text).not.toContain(mark);
      }
    }
  }, 60_000);

  it("读盘量有上限 —— 绝不整文件读", () => {
    const big = all
      .filter((s) => s.agent !== "opencode" && s.agent !== "grok")
      .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())[0];
    if (!big) return;
    const p = buildPayload(big);
    expect(p.bytesRead).toBeLessThanOrEqual(8 * 1024 * 1024);
  }, 60_000);
});
