import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveCommand } from "./resolve";

// 这些断言依赖本机装了那五个 agent（DESIGN.md §10 记录的环境事实）。
// 装不全时对应用例会跳过，而不是把整个套件搞红。
const AGENTS = ["claude", "codex", "opencode", "pi", "grok"] as const;

describe("resolveCommand", () => {
  it("PATH 里的普通 exe 直接命中", () => {
    const r = resolveCommand("cmd.exe");
    expect(r.exe.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(r.args).toEqual([]);
  });

  it("找不到的命令要抛错，且错误信息里含命令名", () => {
    expect(() => resolveCommand("agentory-绝不存在的命令")).toThrow(/agentory-绝不存在的命令/);
  });

  for (const agent of AGENTS) {
    it(`把 ${agent} 解析成真实存在的可执行文件`, (ctx) => {
      let r;
      try {
        r = resolveCommand(agent);
      } catch {
        ctx.skip(); // 本机没装这个 agent
        return;
      }
      expect(existsSync(r.exe), `${r.exe} 应该存在`).toBe(true);
      // 绝不能解析成 .cmd —— Windows 的 CreateProcess 跑不了它，正是这个函数要解决的问题
      expect(r.exe.toLowerCase().endsWith(".cmd")).toBe(false);
      // 走 node 脚本的形式，脚本文件也必须真实存在
      for (const a of r.args) expect(existsSync(a), `${a} 应该存在`).toBe(true);
    });
  }
});
