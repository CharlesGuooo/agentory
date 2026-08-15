import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentId } from "../sessions/types";
import { readSkills, skillsRoot } from "./skills";

const scratch = mkdtempSync(join(tmpdir(), "agentory-skills-"));

function root(name: string, layout: Record<string, string | null>): string {
  const r = join(scratch, name);
  mkdirSync(r, { recursive: true });
  for (const [rel, body] of Object.entries(layout)) {
    const p = join(r, rel);
    if (body === null) {
      mkdirSync(p, { recursive: true });
    } else {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, body);
    }
  }
  return r;
}

describe("skill = 含 SKILL.md 的目录", () => {
  /**
   * **这条就是让 40 变成 38 的那一刀。**
   * 本机 `~/.claude/skills` 下有 40 个条目，但其中 `catalog.json`、`skill-rules.json`
   * 是文件，`archived/`（opencode 那边）是目录但里面没有 SKILL.md。
   */
  it("跳过散落的文件和没有 SKILL.md 的目录", () => {
    const r = root("a", {
      "brainstorming/SKILL.md": "# x",
      "pdf/SKILL.md": "# y",
      "catalog.json": "{}",
      "skill-rules.json": "{}",
      "README.md": "# 说明",
      "archived": null, // 是目录，但没有 SKILL.md
    });
    const got = readSkills(r);
    expect(got.entries.map((e) => e.name)).toEqual(["brainstorming", "pdf"]);
    expect(got.state).toBe("ok");
  });

  it("带子目录的 skill 照样算（pdf 有 scripts/ 和 references/）", () => {
    const r = root("b", {
      "pdf/SKILL.md": "# x",
      "pdf/scripts/fill.py": "print(1)",
      "pdf/references/forms.md": "# f",
    });
    expect(readSkills(r).entries.map((e) => e.name)).toEqual(["pdf"]);
  });

  it("按名字排序 —— 列表顺序不该随文件系统而变", () => {
    const r = root("c", { "zeta/SKILL.md": "x", "alpha/SKILL.md": "x", "mid/SKILL.md": "x" });
    expect(readSkills(r).entries.map((e) => e.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("path 指向 skill 目录本身 —— 装卸都以它为准", () => {
    const r = root("d", { "one/SKILL.md": "x" });
    expect(readSkills(r).entries[0]?.path).toBe(join(r, "one"));
  });

  /** 「空」和「读不到」必须能区分：读不动显示成 0 条就是显示错的东西。 */
  it("目录不存在是 missing，不是 empty", () => {
    expect(readSkills(join(scratch, "根本没有这个目录"))).toEqual({ entries: [], state: "missing" });
  });

  it("目录在但一个 skill 都没有才是 empty", () => {
    const r = root("e", { "catalog.json": "{}" });
    expect(readSkills(r).state).toBe("empty");
  });
});

describe("五个 agent 的 skills 目录", () => {
  const AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

  it("全局路径各不相同，且都是绝对路径", () => {
    const roots = AGENTS.map((a) => skillsRoot(a, { kind: "global" }));
    for (const r of roots) expect(r).toMatch(/^[A-Za-z]:[\\/]/);
    expect(new Set(roots).size).toBe(AGENTS.length);
  });

  it("项目级路径接在项目根下面", () => {
    const cwd = "C:\\proj";
    expect(skillsRoot("claude", { kind: "project", cwd })).toBe(join(cwd, ".claude", "skills"));
    expect(skillsRoot("pi", { kind: "project", cwd })).toBe(join(cwd, ".pi", "skills"));
  });
});

describe("真机：五个 agent 的全局 skills", () => {
  it("读得出来，且散落文件没混进去", () => {
    const AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];
    const rows = AGENTS.map((agent) => {
      const r = readSkills(skillsRoot(agent, { kind: "global" }));
      return { agent, ...r };
    });

    console.log(
      "\n" +
        rows
          .map((r) => `  ${r.agent.padEnd(9)} ${String(r.entries.length).padStart(3)} 个   ${r.state}`)
          .join("\n") +
        "\n",
    );

    const found = rows.filter((r) => r.state === "ok");
    expect(found.length, "一个 agent 的 skills 都没读到").toBeGreaterThan(0);

    // 这几个在本机真实存在于 skills 目录下，但**不是** skill —— 混进来就说明定义写错了
    const NOT_SKILLS = ["catalog.json", "skill-rules.json", "README.md", "archived"];
    for (const r of rows) {
      for (const bad of NOT_SKILLS) {
        expect(r.entries.map((e) => e.name), `${r.agent} 把 ${bad} 当成 skill 了`).not.toContain(bad);
      }
    }
  });
});
