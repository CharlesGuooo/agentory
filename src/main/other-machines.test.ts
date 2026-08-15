import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexMcp, readGrokMcp, readOpenCodeMcp } from "./harness/mcp";
import { readSkills, skillsRoot } from "./harness/skills";
import { agentPaths } from "./paths";
import { scanClaude } from "./sessions/claude";
import { scanCodex } from "./sessions/codex";
import { scanGrok } from "./sessions/grok";
import { scanPi } from "./sessions/pi";

/**
 * # 「别人的机器」
 *
 * 到这一刀为止，**所有验证都只在开发机上做过**。而开发机恰好是五个 agent 全装、
 * 全部走默认路径、用户名是 ASCII、家目录没被重定向的那种 —— 客户机器几乎不会都这样。
 *
 * 这个文件在临时目录里**造出别人的机器**，再让真扫描器去读。
 * 这样「担心别人的机器不一样」就变成了可重复的测试，而不是靠想象。
 *
 * ## 为什么有些用例走 `vi.stubEnv` 而不是传路径参数
 *
 * 传路径只验了读取逻辑，**验不到「路径是怎么算出来的」那一段** ——
 * 而那正是这一刀新改的东西。设环境变量能让 `agentPaths()` 走真实的解析链路，
 * 从环境变量一路到最终读到文件，中间一段都不跳过。
 */

const scratch = mkdtempSync(join(tmpdir(), "agentory-other-"));
let n = 0;

/** 造一个目录树。值为 null 表示只建目录。 */
function machine(name: string, layout: Record<string, string | null>): string {
  const root = join(scratch, `${n++}-${name}`);
  for (const [rel, body] of Object.entries(layout)) {
    const p = join(root, rel);
    if (body === null) mkdirSync(p, { recursive: true });
    else {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, body);
    }
  }
  mkdirSync(root, { recursive: true });
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("配置目录被环境变量搬走了（走真实解析链路）", () => {
  /**
   * 客户设了 `CLAUDE_CONFIG_DIR`，我们必须去那儿找。
   * 找错的后果不是报错，是**静默显示成「这个 agent 没有 skill」** —— 最糟的失败模式。
   */
  it("CLAUDE_CONFIG_DIR：skills 要从新位置读出来", () => {
    const cfg = machine("claude-cfg", {
      "skills/我的技能/SKILL.md": "---\nname: 我的技能\n---\n",
      "skills/another/SKILL.md": "x",
    });
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);

    const root = skillsRoot("claude", { kind: "global" });
    expect(root).toBe(join(cfg, "skills"));
    expect(readSkills(root).entries.map((e) => e.name).sort()).toEqual(["another", "我的技能"]);
  });

  it("CLAUDE_CONFIG_DIR：会话目录也跟着走", () => {
    const cfg = machine("claude-sess", { "projects": null });
    vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
    // 目录存在但里面没会话 —— 应当是「0 条」而不是抛错
    expect(scanClaude().sessions).toEqual([]);
    expect(agentPaths().claude.configDir.via).toBe("CLAUDE_CONFIG_DIR");
  });

  it("CODEX_HOME：MCP 配置从新位置读", () => {
    const home = machine("codex-home", {
      "config.toml": '[mcp_servers."从新位置读到的"]\ncommand = "npx"\n',
    });
    vi.stubEnv("CODEX_HOME", home);
    const r = readCodexMcp();
    expect(r.state).toBe("ok");
    expect(r.entries.map((e) => e.name)).toEqual(["从新位置读到的"]);
  });

  it("OPENCODE_CONFIG_DIR", () => {
    const cfg = machine("oc", {
      "opencode.json": JSON.stringify({ mcp: { 新位置: { type: "local", command: ["x"] } } }),
    });
    vi.stubEnv("OPENCODE_CONFIG_DIR", cfg);
    expect(readOpenCodeMcp().entries.map((e) => e.name)).toEqual(["新位置"]);
  });

  /** XDG 变量是**一整批** agent 共用的 —— 设一个会同时影响 opencode 和 grok。 */
  it("XDG_CONFIG_HOME 同时影响 opencode 和 grok", () => {
    const xdg = machine("xdg", {
      "opencode/opencode.json": JSON.stringify({ mcp: {} }),
      "grok/config.toml": '[mcp_servers.g]\ncommand = "grok"\n',
    });
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    expect(skillsRoot("opencode", { kind: "global" })).toBe(join(xdg, "opencode", "skills"));
    expect(readGrokMcp().entries.map((e) => e.name)).toEqual(["g"]);
  });

  it("GROK_HOME 优先于 XDG_CONFIG_HOME", () => {
    const xdg = machine("both-xdg", { "grok/config.toml": '[mcp_servers."从xdg"]\ncommand = "x"\n' });
    const gh = machine("both-gh", { "config.toml": '[mcp_servers."从GROK_HOME"]\ncommand = "x"\n' });
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    vi.stubEnv("GROK_HOME", gh);
    expect(readGrokMcp().entries.map((e) => e.name)).toEqual(["从GROK_HOME"]);
  });

  /** 环境变量指的位置不存在时，必须回落到默认位置，而不是就此认定「没有」。 */
  it("环境变量指向一个不存在的目录时，回落到默认位置", () => {
    vi.stubEnv("CODEX_HOME", join(scratch, "这个目录根本不存在"));
    const p = agentPaths();
    expect(p.codex.home.tried.length).toBe(2);
    // 本机装了 codex，所以回落之后应当找得到
    expect(p.codex.home.found).toBe(true);
    expect(p.codex.home.via).toBeNull();
  });
});

describe("只装了一部分 agent，或一个都没装", () => {
  /** 客户不一定五个都装。没装的必须是「没有」，不能是崩、也不能是「读不出」。 */
  it("目录不存在 = missing，五个读取器都不抛", () => {
    const empty = join(scratch, "空空如也");
    expect(readSkills(join(empty, "skills")).state).toBe("missing");
    expect(readCodexMcp(join(empty, "config.toml")).state).toBe("missing");
    expect(readOpenCodeMcp(join(empty, "opencode.json")).state).toBe("missing");
    expect(readGrokMcp(join(empty, "config.toml")).state).toBe("missing");
  });

  it("会话扫描器对着不存在的根返回空，不抛", () => {
    const nope = join(scratch, "也不存在");
    expect(scanClaude(nope).sessions).toEqual([]);
    expect(scanCodex(nope).sessions).toEqual([]);
    expect(scanGrok(nope).sessions).toEqual([]);
    expect(scanPi(nope).sessions).toEqual([]);
  });

  /** 配置文件在但内容是空的 —— 「有这个 agent 但没配过」，和「没装」不是一回事。 */
  it("配置在但没有条目 = empty，不是 missing", () => {
    const m = machine("empty-cfg", {
      "config.toml": "# 什么都没配\n",
      "opencode.json": "{}",
      "skills": null,
    });
    expect(readCodexMcp(join(m, "config.toml")).state).toBe("empty");
    expect(readOpenCodeMcp(join(m, "opencode.json")).state).toBe("empty");
    expect(readSkills(join(m, "skills")).state).toBe("empty");
  });

  /**
   * **TOML 的裸键只允许 `A-Za-z0-9_-`**，中文服务器名必须写成 `["名字"]`。
   * 客户要是写了没加引号的中文键，整个文件就是非法 TOML ——
   * 这时候必须报 `unreadable`（「读不出来」），**不能报 empty**（「你没配」）。
   * 这条是实测撞出来的：第一版夹具就写错了。
   */
  it("裸键是中文的 TOML 是非法的，要报读不出来而不是没配", () => {
    const m = machine("bare-cjk", {
      "config.toml": '[mcp_servers.中文裸键]\ncommand = "x"\n',
    });
    expect(readCodexMcp(join(m, "config.toml")).state).toBe("unreadable");
  });

  /** 文件坏了必须是 unreadable —— **绝不能当成 0 条**，那会显示成「你没配」。 */
  it("配置文件坏了 = unreadable，不是 empty", () => {
    const m = machine("broken", { "config.toml": "[[[坏的", "opencode.json": "{ 不是 JSON" });
    expect(readCodexMcp(join(m, "config.toml")).state).toBe("unreadable");
    expect(readOpenCodeMcp(join(m, "opencode.json")).state).toBe("unreadable");
  });
});

describe("路径本身不一样的机器", () => {
  /** 中文用户名很常见，路径带空格也是。 */
  it("中文 + 空格 + 括号的路径", () => {
    const m = machine("路径 测试 (中文)", {
      "skills/技能一/SKILL.md": "x",
      "config.toml": '[mcp_servers."中文服务器"]\ncommand = "npx"\n',
    });
    expect(readSkills(join(m, "skills")).entries.map((e) => e.name)).toEqual(["技能一"]);
    expect(readCodexMcp(join(m, "config.toml")).entries.map((e) => e.name)).toEqual(["中文服务器"]);
  });

  /**
   * Windows 的 260 字符上限。skill 目录本来就不浅
   * （`<配置>/skills/<名字>/references/<文件>`），客户的家目录再深一点就会撞上。
   */
  it("很深的路径", () => {
    const deep = Array.from({ length: 8 }, (_, i) => `level-${i}-a-fairly-long-directory-name-here`).join("\\");
    const m = machine("deep", { [`${deep}\\skills\\某技能\\SKILL.md`]: "x" });
    const root = join(m, deep, "skills");
    expect(root.length).toBeGreaterThan(260);
    expect(readSkills(root).entries.map((e) => e.name)).toEqual(["某技能"]);
  });
});

describe("规模不一样的机器", () => {
  /**
   * 开发机的 `.claude.json` 是 178 KB。重度用户报告过百 MB 级的 ——
   * 那份文件里除了 `mcpServers` 还有几百个 project 条目。
   */
  it("很大的 .claude.json 也能只取出 mcpServers", () => {
    const big = {
      mcpServers: { 目标: { command: "npx", args: ["-y", "x"] } },
      // 模拟几百个 project 条目
      projects: Object.fromEntries(
        Array.from({ length: 400 }, (_, i) => [
          `C:\\some\\project\\number-${i}`,
          { allowedTools: Array.from({ length: 20 }, (_, j) => `tool-${j}`), history: "x".repeat(500) },
        ]),
      ),
    };
    const m = machine("big", { ".claude.json": JSON.stringify(big) });
    const path = join(m, ".claude.json");
    vi.stubEnv("CLAUDE_CONFIG_DIR", m);

    const t0 = performance.now();
    const p = agentPaths();
    const ms = performance.now() - t0;
    expect(p.claude.claudeJson.path).toBe(path);
    console.log(`  ${Math.round(JSON.stringify(big).length / 1024)} KB 的 .claude.json，解析路径耗时 ${ms.toFixed(1)} ms`);
  });
});
