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

  /**
   * 守住「不建索引数据库」这个决定（D-4）。
   *
   * **原来断言的是「总耗时 < 1 秒」，2026-08-15 改成断言单条成本。**
   * 不是因为超了就调参数 —— 而是那个阈值量的是「本机此刻有多少会话」，
   * 而本机的语料每天都在长（开发这个应用本身就在往里写会话）。实测：
   *
   * | | 总耗时 |
   * |---|---|
   * | 定阈值时 | 665 ms |
   * | 这一刀之前的 HEAD（并发套件下） | **941 ms** |
   * | 这一刀之后 | 727–755 ms（单独）· ~1000 ms（并发套件下）|
   *
   * 也就是说 HEAD 自己就已经贴着 1 秒了，这条测试早晚会在某天无关的提交上翻红。
   * 真正支撑 D-4 的不变量是**单条成本恒定**（线性、常数小），它不随语料变大而漂移。
   *
   * ⚠️ 但总耗时是真会被用户感觉到的：`sessions:list` 就在「打开历史」的路径上，
   * 436 条 ≈ 0.75 秒的卡顿。这条测试不再守它，所以它被单独记进了 DESIGN.md 的待办。
   *
   * **阈值放到 8 ms 是因为这里量不准，不是因为 8 ms 可以接受。**
   * 测试文件是并行跑的，这个数字里混着别的文件在抢磁盘：同一份代码，
   * 单独跑 1.7 ms/条，全套件里 4.3 ms/条。所以它只配当「数量级护栏」——
   * 它今天真的抓到了一次 15 倍的回归（opencode 的 SQL 窗口，23 ms/条）。
   * 要干净的数字用 `npm run perf`，那个是单独跑的。
   */
  it("单条成本没有数量级回归（守住「不建索引数据库」这个决定）", () => {
    const per = elapsed / result.sessions.length;
    console.log(
      `  单条 ${per.toFixed(2)} ms × ${result.sessions.length} 条 = ${elapsed.toFixed(0)} ms`,
    );
    expect(per).toBeLessThan(8);
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

  /**
   * **只挑「安静」的文件。**
   *
   * 原来取的是最近 30 条 —— 那恰好是最可能**正被别的 agent 追加**的那些
   * （开发这个应用的时候，Claude 就在往自己的会话文件里写）。
   * 别人在写，不构成「我们写了」的证据，但会让这条测试随机翻红。
   *
   * 换成只看 10 分钟内没动过的文件：**我们真要是会写，老文件一样会被写。**
   * 属性没有被削弱，只是把别人的噪声排除掉了。
   */
  it("扫描是只读的 —— 前后 source 的 mtime 不变", () => {
    const QUIET_MS = 10 * 60 * 1000;
    const now = Date.now();
    const sample = result.sessions
      .filter((s) => existsSync(s.source) && now - statSync(s.source).mtimeMs > QUIET_MS)
      .slice(0, 30);
    // 全都在动就等于什么也没验，这时候要吵，不要静悄悄地通过
    expect(sample.length, "没有一个安静的样本可验").toBeGreaterThan(0);

    const before = sample.map((s) => statSync(s.source).mtimeMs);
    scanAllAgents();
    const after = sample.map((s) => statSync(s.source).mtimeMs);
    expect(after).toEqual(before);
  });
});
