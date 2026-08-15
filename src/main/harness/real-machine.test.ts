import { describe, expect, it, vi } from "vitest";
import { scanHarness } from "./all";
import type { AgentId } from "../sessions/types";

/** 记下所有起过的子进程。`vi.mock` 被提升，所以数组必须走 `vi.hoisted`。 */
const spawned = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    execFileSync: (file: string, args?: readonly string[], opts?: unknown) => {
      spawned.push([file, ...(args ?? [])]);
      return (real.execFileSync as (...a: unknown[]) => unknown)(file, args, opts);
    },
  };
});

/** 记下所有写文件的动作。「零缓存」必须是结构，不是纪律。 */
const written = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: (p: unknown, ...rest: unknown[]) => {
      written.push(String(p));
      return (real.writeFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
    mkdirSync: (p: unknown, ...rest: unknown[]) => {
      written.push(String(p));
      return (real.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

const AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

describe("真机：全局 harness", () => {
  it("打印实测报告", () => {
    const m = scanHarness({ kind: "global" });

    const rows = m.sources.map((s) => {
      const where = s.path === "" ? "(不适用)" : s.path.replace(/^.*[\\/]Users[\\/][^\\/]+/, "~");
      return `  ${s.agent.padEnd(9)} ${s.kind.padEnd(7)} ${String(s.count).padStart(3)} 个  ${s.state.padEnd(13)} ${where}`;
    });

    console.log(
      [
        "",
        `MCP 行 ${m.mcp.length} 条 · skills 行 ${m.skills.length} 条`,
        ...rows,
        `  ${"—".repeat(70)}`,
        ...m.sources.filter((s) => s.note).map((s) => `  [${s.agent}] ${s.note}`),
        ...m.problems.map((p) => `  ⚠ ${p}`),
        "",
        "  只有部分 agent 有的 MCP：",
        ...m.mcp
          .filter((r) => Object.keys(r.byAgent).length < 4)
          .slice(0, 8)
          .map((r) => `    ${r.name.padEnd(28)} ${Object.keys(r.byAgent).join("、")}`),
        "",
        "  配置里存着明文密钥的：",
        ...m.mcp
          .flatMap((r) =>
            Object.entries(r.byAgent).flatMap(([agent, es]) =>
              (es ?? [])
                .filter((e) => e.inlineSecrets.length > 0)
                .map((e) => `    ${agent.padEnd(9)} ${r.name.padEnd(22)} ${e.inlineSecrets.join("、")}`),
            ),
          )
          .slice(0, 10),
        "",
      ].join("\n"),
    );

    expect(m.sources.length).toBeGreaterThan(0);
  });

  /** 不变量，不是语料数字 —— 语料会变，这些不会。 */
  it("pi 的 MCP 恒为 unsupported，不是「0 个」", () => {
    const m = scanHarness({ kind: "global" });
    const pi = m.sources.find((s) => s.agent === "pi" && s.kind === "mcp");
    expect(pi?.state).toBe("unsupported");
    expect(pi?.note).toContain("不支持 MCP");
  });

  it("没有任何来源是 unreadable（本机五个都装了）", () => {
    const m = scanHarness({ kind: "global" });
    const bad = m.sources.filter((s) => s.state === "unreadable");
    expect(bad.map((s) => `${s.agent}/${s.kind}`)).toEqual([]);
  });

  /**
   * **出现 unknown 就说明有字段形状我们没认出来。** 这条断言正是要被告知那件事。
   */
  it("每条 MCP 都认得出 stdio 还是 http，没有 unknown", () => {
    const m = scanHarness({ kind: "global" });
    const unknown = m.mcp.flatMap((r) =>
      Object.entries(r.byAgent).flatMap(([agent, es]) =>
        (es ?? []).filter((e) => e.target.kind === "unknown").map(() => `${agent}/${r.name}`),
      ),
    );
    expect(unknown).toEqual([]);
  });

  /** 混进值几乎必然不满足这个形状 —— 这是「只取键名」的一条廉价旁证。 */
  it("envNames 全都长得像环境变量名", () => {
    const m = scanHarness({ kind: "global" });
    for (const r of m.mcp) {
      for (const [agent, es] of Object.entries(r.byAgent)) {
        for (const e of es ?? []) {
          for (const nm of e.envNames) {
            expect(nm, `${agent}/${r.name} 的 envNames 里混进了不像变量名的东西`).toMatch(
              /^[A-Za-z_][A-Za-z0-9_]*$/,
            );
          }
        }
      }
    }
  });

  /** skill = 含 SKILL.md 的目录。这几个在真目录里存在，但不是 skill。 */
  it("catalog.json / README.md / archived 没被当成 skill", () => {
    const m = scanHarness({ kind: "global" });
    const names = m.skills.map((r) => r.name);
    for (const bad of ["catalog.json", "skill-rules.json", "README.md", "archived"]) {
      expect(names).not.toContain(bad);
    }
  });

  it("每个 agent 都有 skills 来源记录", () => {
    const m = scanHarness({ kind: "global" });
    for (const a of AGENTS) {
      expect(m.sources.some((s) => s.agent === a && s.kind === "skills"), `${a} 缺 skills 记录`).toBe(true);
    }
  });

  /**
   * **真机版秘密测试。** fixture 只能证明我们对自己造的数据是对的；
   * 这一条读的是真配置 —— 本机 claude 有 2 处、opencode 有 3 处明文 token。
   */
  it("真配置里的明文密钥值没有进结果", () => {
    const m = scanHarness({ kind: "global" });
    const dumped = JSON.stringify(m);

    const paths = m.mcp.flatMap((r) =>
      Object.values(r.byAgent).flatMap((es) => (es ?? []).flatMap((e) => e.inlineSecrets)),
    );
    console.log(`  实测：${paths.length} 处字段存着明文（只记路径，不记值）`);

    // 这些是真值可能长的样子。绝不打印它们，只断言不存在。
    for (const pattern of [/\bghp_[A-Za-z0-9]{20,}/, /\bsk-[A-Za-z0-9-]{20,}/, /Bearer\s+[A-Za-z0-9._-]{16,}/]) {
      expect(dumped, `结果里出现了像密钥的字符串：${pattern}`).not.toMatch(pattern);
    }
  });
});

describe("结构性约束", () => {
  it("扫描过程一个 agent 子进程都没起、一个文件都没写", () => {
    spawned.length = 0;
    written.length = 0;
    scanHarness({ kind: "global" });

    expect(spawned.map((c) => c.join(" ")), "起了子进程").toEqual([]);
    // 零缓存：这个功能刻意不写任何文件，缓存文件是秘密唯一可能被持久化的地方
    expect(written, "写了文件").toEqual([]);
  });
});

describe("项目级作用域", () => {
  it("读本仓库自己的 .claude/skills/", () => {
    const m = scanHarness({ kind: "project", cwd: process.cwd() });
    const claude = m.sources.find((s) => s.agent === "claude" && s.kind === "skills");
    console.log(`  本项目 .claude/skills：${claude?.count} 个（${claude?.state}）`);
    expect(claude?.state).toBe("ok");
    expect(claude?.count).toBeGreaterThan(0);
    // 项目级作用域不读 MCP（只有 claude/grok 支持，v1 不做）
    expect(m.sources.filter((s) => s.kind === "mcp")).toEqual([]);
  });
});
