import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentPaths, resolveFirst } from "./paths";

const scratch = mkdtempSync(join(tmpdir(), "agentory-paths-"));
const dir = (...parts: string[]): string => {
  const p = join(scratch, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

describe("按顺序取第一个存在的候选", () => {
  it("第一个存在就用第一个", () => {
    const a = dir("a");
    const r = resolveFirst([
      { path: a, via: "MY_VAR" },
      { path: join(scratch, "不存在"), via: null },
    ]);
    expect(r).toEqual({ path: a, tried: [a, join(scratch, "不存在")], found: true, via: "MY_VAR" });
  });

  it("第一个不存在就往下走", () => {
    const b = dir("b");
    const r = resolveFirst([{ path: join(scratch, "没有"), via: "MY_VAR" }, { path: b, via: null }]);
    expect(r.path).toBe(b);
    expect(r.found).toBe(true);
    expect(r.via).toBeNull();
  });

  /**
   * **都不存在时不能返回空。**
   * 返回第一个候选，界面才说得出「我们期望它在这里，但它不在」——
   * 这比干巴巴一句「没有」有用得多，也是诊断面板存在的理由。
   */
  it("一个都不存在时，返回第一个候选并标 found=false，且 tried 记全", () => {
    const c1 = join(scratch, "没有1");
    const c2 = join(scratch, "没有2");
    const r = resolveFirst([{ path: c1, via: "V" }, { path: c2, via: null }]);
    expect(r).toEqual({ path: c1, tried: [c1, c2], found: false, via: "V" });
  });

  it("空的环境变量当没设 —— 候选里不该出现空路径", () => {
    const d = dir("d");
    const r = resolveFirst([{ path: "", via: "EMPTY" }, { path: d, via: null }]);
    expect(r.tried).toEqual([d]);
    expect(r.path).toBe(d);
  });
});

describe("五个 agent 的路径解析", () => {
  const home = "C:\\Users\\某人";

  /** 没设任何环境变量时，就是各自的默认位置。 */
  it("默认位置", () => {
    const p = agentPaths(home, {});
    expect(p.claude.configDir.tried[0]).toBe(join(home, ".claude"));
    expect(p.claude.claudeJson.tried[0]).toBe(join(home, ".claude.json"));
    expect(p.codex.home.tried[0]).toBe(join(home, ".codex"));
    expect(p.opencode.configDir.tried[0]).toBe(join(home, ".config", "opencode"));
    expect(p.opencode.dataDir.tried[0]).toBe(join(home, ".local", "share", "opencode"));
    expect(p.grok.home.tried[0]).toBe(join(home, ".grok"));
    expect(p.pi.agentDir.tried[0]).toBe(join(home, ".pi", "agent"));
  });

  /** 官方文档与 claude.exe 里都确认了 CLAUDE_CONFIG_DIR。 */
  it("CLAUDE_CONFIG_DIR 排在默认位置前面", () => {
    const p = agentPaths(home, { CLAUDE_CONFIG_DIR: "D:\\cfg\\claude" });
    expect(p.claude.configDir.tried).toEqual(["D:\\cfg\\claude", join(home, ".claude")]);
    expect(p.claude.configDir.via).toBe("CLAUDE_CONFIG_DIR");
  });

  /**
   * `.claude.json` 是 `~/.claude` 的**兄弟**不是子目录，
   * 而 CLAUDE_CONFIG_DIR 到底会不会把它一起搬走，文档没说清。
   * **两个都试** —— 这样我们不必赌对，只要候选里包含正确答案就找得到。
   */
  it("CLAUDE_CONFIG_DIR 下的 .claude.json 也要试", () => {
    const p = agentPaths(home, { CLAUDE_CONFIG_DIR: "D:\\cfg\\claude" });
    expect(p.claude.claudeJson.tried).toEqual([
      join("D:\\cfg\\claude", ".claude.json"),
      join(home, ".claude.json"),
    ]);
  });

  it("CODEX_HOME", () => {
    const p = agentPaths(home, { CODEX_HOME: "E:\\codex" });
    expect(p.codex.home.tried).toEqual(["E:\\codex", join(home, ".codex")]);
  });

  /** opencode 的二进制里 OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME / XDG_DATA_HOME 全都在。 */
  it("opencode：OPENCODE_CONFIG_DIR 优先于 XDG_CONFIG_HOME 优先于默认", () => {
    const p = agentPaths(home, {
      OPENCODE_CONFIG_DIR: "F:\\oc",
      XDG_CONFIG_HOME: "G:\\xdg",
    });
    expect(p.opencode.configDir.tried).toEqual([
      "F:\\oc",
      join("G:\\xdg", "opencode"),
      join(home, ".config", "opencode"),
    ]);
  });

  it("opencode 的数据目录走 XDG_DATA_HOME（会话库在那儿）", () => {
    const p = agentPaths(home, { XDG_DATA_HOME: "H:\\data" });
    expect(p.opencode.dataDir.tried).toEqual([
      join("H:\\data", "opencode"),
      join(home, ".local", "share", "opencode"),
    ]);
  });

  it("GROK_HOME", () => {
    const p = agentPaths(home, { GROK_HOME: "I:\\grok" });
    expect(p.grok.home.tried).toEqual(["I:\\grok", join(home, ".grok")]);
  });

  /** pi 的包和二进制里都没找到覆盖变量 —— 没找到就不编一个。 */
  it("pi 没有已知的覆盖变量，只有一个候选", () => {
    const p = agentPaths(home, { PI_HOME: "J:\\pi" });
    expect(p.pi.agentDir.tried).toEqual([join(home, ".pi", "agent")]);
  });

  it("环境变量是空串时当没设", () => {
    const p = agentPaths(home, { CLAUDE_CONFIG_DIR: "", CODEX_HOME: "   " });
    expect(p.claude.configDir.tried).toEqual([join(home, ".claude")]);
    expect(p.codex.home.tried).toEqual([join(home, ".codex")]);
  });
});

describe("真机", () => {
  it("五个 agent 的路径都解析得出来，打印实际用的是哪条", () => {
    const p = agentPaths();
    const rows = [
      ["claude 配置", p.claude.configDir],
      ["claude.json", p.claude.claudeJson],
      ["codex", p.codex.home],
      ["opencode 配置", p.opencode.configDir],
      ["opencode 数据", p.opencode.dataDir],
      ["grok", p.grok.home],
      ["pi", p.pi.agentDir],
    ] as const;
    console.log(
      "\n" +
        rows
          .map(
            ([name, r]) =>
              `  ${name.padEnd(14)} ${r.found ? "✓" : "✗"} ${r.via ? `[${r.via}] ` : ""}${r.path}` +
              (r.tried.length > 1 ? `   （试过 ${r.tried.length} 个）` : ""),
          )
          .join("\n") +
        "\n",
    );
    // 本机五个都装了，所以都该找得到
    for (const [name, r] of rows) expect(r.found, `${name} 没找到：试过 ${r.tried.join(" / ")}`).toBe(true);
  });
});
