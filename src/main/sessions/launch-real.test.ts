import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveCommand } from "../terminal/resolve";
import { spawnSession } from "../terminal/session";
import { scanAllAgents } from "./all";
import { availableAgents, folderSuggestions, validateTarget } from "./launch";

const scratch = mkdtempSync(join(tmpdir(), "agentory-newreal-"));
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 残留无害 */
  }
});

/**
 * 走与 `launch:start` **完全相同**的路径起一个会话：
 * `validateTarget` → `resolveCommand` → `spawnSession`。
 * 不复制逻辑 —— 复制出来的测试只能证明副本是对的。
 */
async function startLike(agent: string, cwd: string, ms: number): Promise<string> {
  validateTarget(cwd);
  const r = resolveCommand(agent);
  const s = spawnSession({ command: r.exe, args: r.args, cwd, cols: 120, rows: 34 });
  let out = "";
  s.onData((c) => (out += c));
  await new Promise((res) => setTimeout(res, ms));
  s.kill();
  await new Promise((res) => setTimeout(res, 300));
  return out;
}

describe("真机新建会话", () => {
  const agents = availableAgents(resolveCommand);

  it("本机检测到的 agent 与 PATH 一致", () => {
    console.log(`\n  可用 agent: ${agents.join(", ") || "(无)"}\n`);
    expect(agents.length).toBeGreaterThan(0);
  });

  it("目录候选全部真实存在，且无重复", () => {
    const folders = folderSuggestions(scanAllAgents().sessions);
    console.log(`  目录候选: ${folders.length} 个，最近的是 ${folders[0]}\n`);
    expect(folders.length).toBeGreaterThan(0);
    expect(new Set(folders).size).toBe(folders.length);
    for (const f of folders) expect(existsSync(f), f).toBe(true);
  });

  it(
    "在一个全新的空目录里起 claude —— 证明用的是选定目录，不是别处",
    async (ctx) => {
      if (!agents.includes("claude")) return void ctx.skip();
      const out = await startLike("claude", scratch, 12_000);
      console.log(`  在 ${scratch} 起 claude：收到 ${out.length} 字节\n`);
      expect(out.length).toBeGreaterThan(500);
      // claude 会把 cwd 的末段显示在欢迎屏上
      const leaf = scratch.split(/[\\/]/).filter(Boolean).pop()!;
      expect(out).toContain(leaf);
    },
    40_000,
  );

  it(
    "再验一个非 claude 的 agent 也能起来",
    async (ctx) => {
      const other = agents.find((a) => a !== "claude");
      if (!other) return void ctx.skip();
      const out = await startLike(other, scratch, 12_000);
      console.log(`  在 ${scratch} 起 ${other}：收到 ${out.length} 字节\n`);
      expect(out.length).toBeGreaterThan(200);
    },
    40_000,
  );

  it("不存在的目录被拒，且拒绝之后目录仍不存在", () => {
    const gone = join(scratch, "根本没有这个目录");
    expect(() => validateTarget(gone)).toThrow(gone);
    // 悄悄 mkdir 然后开个空会话，用户会以为自己进错了项目
    expect(existsSync(gone)).toBe(false);
  });
});
