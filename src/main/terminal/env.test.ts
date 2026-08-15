import { describe, expect, it } from "vitest";
import { cleanEnv, isAgentRuntimeVar } from "./env";
import { spawnSession } from "./session";

describe("环境变量清洗", () => {
  /** 本机实测到的那 7 个（Q10）。逐个列出来，因为它们是这个功能存在的理由。 */
  it("剔掉父 agent 注入的运行时标记", () => {
    for (const k of [
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_PID",
      "CLAUDE_EFFORT",
      // 做真机验证时才发现的：名字上看不出属于哪个 agent，值里却写着父 agent 的身份
      "AI_AGENT",
    ]) {
      expect(isAgentRuntimeVar(k)).toBe(true);
    }
  });

  it("同样的形状对另外四个 agent 也成立", () => {
    for (const k of ["CODEX_SESSION_ID", "OPENCODE_ENTRYPOINT", "GROK_PID", "PI_SESSION"]) {
      expect(isAgentRuntimeVar(k)).toBe(true);
    }
  });

  /**
   * 分不出「用户自己设的」和「父进程注入的」是这道题唯一的难点。
   * 按名字的形状判断：带 SESSION/PID 那些是运行时，DISABLE_AUTO_MEMORY 是配置。
   * **剔错了会让用户在系统里设的配置在这个应用里悄悄失效。**
   */
  it("看起来像用户配置的一律保留", () => {
    for (const k of [
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "CODEX_HOME",
      "OPENCODE_CONFIG",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
    ]) {
      expect(isAgentRuntimeVar(k)).toBe(false);
    }
  });

  it("普通环境变量一个都不动", () => {
    for (const k of ["PATH", "USERPROFILE", "APPDATA", "TEMP", "HTTP_PROXY", "LANG", "NODE_OPTIONS"]) {
      expect(isAgentRuntimeVar(k)).toBe(false);
    }
  });

  it("不改动入参 —— 入参多半是 process.env，改它等于改整个进程", () => {
    const src = { PATH: "/x", CLAUDE_PID: "123" };
    const out = cleanEnv(src);
    expect(src["CLAUDE_PID"]).toBe("123");
    expect(out["CLAUDE_PID"]).toBeUndefined();
    expect(out["PATH"]).toBe("/x");
  });
});

/**
 * 真机端到端：起一个真进程，把它看到的环境变量打出来。
 *
 * 这条测试**只在从 agent 会话里跑测试时才有意义** —— 那时 process.env 里才有
 * 那些注入变量。所以它自检前提，不满足就跳过，而不是假装通过。
 */
describe("真机验证：子进程拿到的环境", () => {
  it(
    "子进程看不到 CLAUDE_CODE_CHILD_SESSION，但 PATH 还在",
    async (ctx) => {
      if (!process.env["CLAUDE_CODE_CHILD_SESSION"]) {
        return void ctx.skip(); // 不是从 agent 会话里跑的，没得测
      }
      const s = spawnSession({
        command: "cmd.exe",
        args: ["/c", "set"],
        cwd: process.cwd(),
        cols: 120,
        rows: 30,
      });
      let out = "";
      s.onData((c) => (out += c));
      /**
       * **轮询到输出齐了，不固定等。**
       * 这个项目里固定等待时长已经造成过两次偶发红（`resume-real` 与
       * 结束会话的孤儿检查）—— 机器一忙就拍到半截输出，而周期性变红的测试
       * 会训练人忽略红色。这里等到 `set` 把 PATH 打出来、且输出不再增长为止。
       */
      const deadline = Date.now() + 20_000;
      let last = -1;
      while (Date.now() < deadline) {
        if (out.includes("PATH=") && out.length === last) break;
        last = out.length;
        await new Promise((r) => setTimeout(r, 250));
      }
      s.kill();

      expect(out).not.toContain("CLAUDE_CODE_CHILD_SESSION");
      expect(out).not.toContain("CLAUDECODE=");
      expect(out).not.toContain("AI_AGENT=");
      // 清洗不能把正常环境一起清掉。Windows 上 `set` 打的是大写 PATH。
      expect(out).toContain("PATH=");
      // 看起来像用户配置的必须活着 —— 剔错了会让用户在系统里设的配置悄悄失效
      expect(out).toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY=");
      console.log(`\n  子进程环境共 ${out.split("\n").length} 行，未见任何注入标记\n`);
    },
    30_000,
  );
});
