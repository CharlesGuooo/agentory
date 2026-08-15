import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allScanners, scanAllAgents } from "./all";
import type { AgentId, Session } from "./types";

/**
 * 真机全量验证 —— `docs/research-notes.md §8` 定下的验收标准。
 *
 * 刻意写成带断言的测试而不是一次性脚本：会话数会变，但这些不变量必须一直成立。
 * 本机没装某个 agent 时它自然贡献 0 条，不影响其余断言。
 */
describe("真机全量扫描", () => {
  const t0 = performance.now();
  const result = scanAllAgents();
  const elapsed = performance.now() - t0;

  const byAgent = new Map<AgentId, Session[]>();
  for (const s of result.sessions) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);

  it("打印实测报告", () => {
    const withCwd = result.sessions.filter((s) => s.cwd !== null);
    const dead = withCwd.filter((s) => !s.cwdExists);
    const inexact = result.sessions.filter((s) => !s.lastActivityExact);

    const rows = allScanners.map(({ agent }) => {
      const list = byAgent.get(agent) ?? [];
      const ok = list.filter((s) => s.cwd !== null).length;
      const titled = list.filter((s) => s.nativeTitle).length;
      return `  ${agent.padEnd(9)} ${String(list.length).padStart(4)} 个   cwd ${String(ok).padStart(4)}/${String(list.length).padEnd(4)}   原生标题 ${titled}`;
    });

    console.log(
      [
        "",
        `全量扫描：${result.sessions.length} 个会话，${elapsed.toFixed(0)} ms`,
        ...rows,
        `  ${"—".repeat(46)}`,
        `  cwd 解析成功   ${withCwd.length}/${result.sessions.length}`,
        `  cwd 已消失     ${dead.length}（目录被删，会话仍保留）`,
        `  时间不精确     ${inexact.length}（内容里没时间戳，退回 mtime）`,
        `  问题记录       ${result.problems.length}`,
        ...result.problems.slice(0, 5).map((p) => `    ${p.slice(0, 100)}`),
        "",
      ].join("\n"),
    );
    expect(result.sessions.length).toBeGreaterThan(0);
  });

  it("耗时在 1 秒以内（守住「不建索引数据库」这个决定）", () => {
    // 超了不是调参数的事，是回去重新讨论 D-4
    expect(elapsed).toBeLessThan(1000);
  });

  it("按最后活动时间倒序", () => {
    for (let i = 1; i < result.sessions.length; i++) {
      expect(result.sessions[i - 1]!.lastActivity.getTime()).toBeGreaterThanOrEqual(
        result.sessions[i]!.lastActivity.getTime(),
      );
    }
  });

  it("每条 cwd 要么是真实存在的绝对路径，要么明确标记为不存在 —— 没有第三种状态", () => {
    for (const s of result.sessions) {
      if (s.cwd === null) {
        expect(s.cwdExists, `${s.agent}/${s.sessionId}`).toBe(false);
        continue;
      }
      expect(s.cwd, `${s.agent}/${s.sessionId}`).toMatch(/^[A-Za-z]:[\\/]/);
      // 这就是 docs/research-notes.md §8 的验收标准：cwd 必须真的通得过存在性检查
      expect(s.cwdExists, `${s.agent}/${s.sessionId} → ${s.cwd}`).toBe(existsSync(s.cwd));
    }
  });

  it("cwd 解析成功率 > 90%", () => {
    const ok = result.sessions.filter((s) => s.cwd !== null).length;
    expect(ok / result.sessions.length).toBeGreaterThan(0.9);
  });

  it("sessionId 全部非空，且同一 agent 内不重复", () => {
    for (const [agent, list] of byAgent) {
      const ids = list.map((s) => s.sessionId);
      expect(ids.every(Boolean), `${agent} 有空 id`).toBe(true);
      expect(new Set(ids).size, `${agent} 有重复 id`).toBe(ids.length);
    }
  });

  it("只有 OpenCode 采纳了原生标题", () => {
    for (const s of result.sessions) {
      if (s.nativeTitle !== undefined) expect(s.agent).toBe("opencode");
    }
  });

  it("扫描是只读的 —— 前后 source 的 mtime 不变", () => {
    const sample = result.sessions.slice(0, 30).filter((s) => existsSync(s.source));
    const before = sample.map((s) => statSync(s.source).mtimeMs);
    scanAllAgents();
    const after = sample.map((s) => statSync(s.source).mtimeMs);
    expect(after).toEqual(before);
  });
});
