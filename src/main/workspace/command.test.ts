import { describe, expect, it } from "vitest";
import type { AgentId } from "../sessions/types";
import { entryCommand } from "./command";
import type { WorkspaceEntry } from "./model";

const ALL: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

const entry = (agent: AgentId, sessionId: string | null): WorkspaceEntry => ({
  agent,
  sessionId,
  cwd: "C:\\proj",
  addedAt: "2026-08-13T10:00:00.000Z",
});

describe("entryCommand", () => {
  it("知道 id 时用精确恢复", () => {
    const got = Object.fromEntries(
      ALL.map((a) => {
        const c = entryCommand(entry(a, "abc-123"));
        return [a, [c.command, ...c.args].join(" ")];
      }),
    );
    expect(got).toEqual({
      claude: "claude --resume abc-123",
      codex: "codex resume abc-123",
      opencode: "opencode --session abc-123",
      pi: "pi --session abc-123",
      grok: "grok --resume abc-123",
    });
  });

  it("不知道 id 时用「继续该目录下最近的会话」", () => {
    // 在 agentory 里新建的会话，spawn 那一刻拿不到 id —— id 是 agent 自己生成并写进文件的
    const got = Object.fromEntries(
      ALL.map((a) => {
        const c = entryCommand(entry(a, null));
        return [a, [c.command, ...c.args].join(" ")];
      }),
    );
    expect(got).toEqual({
      claude: "claude -c",
      // codex 照例是唯一用子命令的
      codex: "codex resume --last",
      opencode: "opencode -c",
      pi: "pi -c",
      grok: "grok -c",
    });
  });

  it("两种情况都在条目自己的工作目录下执行", () => {
    expect(entryCommand(entry("claude", "x")).cwd).toBe("C:\\proj");
    expect(entryCommand(entry("claude", null)).cwd).toBe("C:\\proj");
  });

  it("任何情况都不出现 --session-id —— 它在会话不存在时会静默新建", () => {
    for (const a of ALL) {
      expect(entryCommand(entry(a, "x")).args, a).not.toContain("--session-id");
      expect(entryCommand(entry(a, null)).args, a).not.toContain("--session-id");
    }
  });

  it("能给出一句可展示给用户的完整命令 —— 「未启动」状态要显示它", () => {
    const c = entryCommand(entry("codex", null));
    expect(c.display).toBe("codex resume --last");
  });
});
