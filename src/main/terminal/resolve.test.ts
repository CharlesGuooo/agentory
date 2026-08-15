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

describe("走 node 脚本的 agent 必须解析到真的 node", () => {
  /**
   * **这条是被诊断面板抓出来的。**
   *
   * `cmd-shim-node` 那条分支原来返回 `process.execPath`。逻辑抄自
   * `probes/resolve-agent.mjs` —— 那是纯 Node 脚本，`execPath` 确实是 node；
   * 但在 **Electron 主进程**里它是 `electron.exe`，而
   * `electron.exe some.js` 不会把 js 当脚本跑，会当成一个 app 去加载。
   * 也就是说 codex 和 pi 在应用里根本起不来。
   *
   * 这个文件里别的测试证明不了这一点：它们在 vitest 下跑，那里
   * `process.execPath` 恰好就是 node，怎么写都对。
   * 所以这条断言的是**结果本身**：解析出来的必须是个 node，而且是从 PATH 上找到的。
   */
  it("codex / pi 解析到 node.exe，且不是靠 electron 回落", (ctx) => {
    const shimNode = (["codex", "pi"] as const)
      .map((a) => {
        try {
          return { agent: a, r: resolveCommand(a) };
        } catch {
          return null;
        }
      })
      .filter((x): x is { agent: "codex" | "pi"; r: ReturnType<typeof resolveCommand> } => x !== null)
      .filter((x) => x.r.via.startsWith("cmd-shim-node"));

    if (shimNode.length === 0) return void ctx.skip();

    for (const { agent, r } of shimNode) {
      console.log(`  ${agent.padEnd(6)} → ${r.exe}${r.env ? `  （回落，带 ${Object.keys(r.env).join()}）` : ""}`);
      expect(r.exe.toLowerCase(), `${agent} 解析成了 electron`).not.toContain("electron");
      expect(r.exe.toLowerCase().endsWith("node.exe"), `${agent} 没解析到 node`).toBe(true);
      // PATH 上找到了真 node，就不该带 ELECTRON_RUN_AS_NODE 那条回落
      expect(r.env, `${agent} 不该需要回落`).toBeUndefined();
    }
  });
});
