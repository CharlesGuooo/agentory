import { describe, expect, it } from "vitest";
import { resumeCommand } from "./resume";
import type { AgentId, Session } from "./types";

function session(agent: AgentId, over: Partial<Session> = {}): Session {
  return {
    agent,
    sessionId: "abc-123",
    cwd: "C:\\Users\\PC\\Desktop\\Recent\\local_GPU",
    cwdExists: true,
    lastActivity: new Date("2026-08-01T00:00:00Z"),
    lastActivityExact: true,
    source: "s",
    ...over,
  };
}

const ALL: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

describe("resumeCommand", () => {
  it("五个 agent 各自的恢复命令", () => {
    const got = Object.fromEntries(
      ALL.map((a) => {
        const r = resumeCommand(session(a));
        return [a, [r.command, ...r.args].join(" ")];
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

  it("codex 用子命令而不是 flag —— README §8 的验收标准", () => {
    const r = resumeCommand(session("codex"));
    expect(r.args[0]).toBe("resume");
    expect(r.args).not.toContain("--resume");
    // 整条命令里不能出现任何以 -- 开头的恢复 flag
    expect(r.args.some((a) => a.startsWith("--"))).toBe(false);
  });

  it("pi 不得使用 --session-id —— 它在会话不存在时会静默新建", () => {
    const r = resumeCommand(session("pi"));
    expect(r.args).toContain("--session");
    expect(r.args).not.toContain("--session-id");
  });

  it("grok 不得使用 --session-id —— 同上，且 README §3.3 记错了", () => {
    const r = resumeCommand(session("grok"));
    expect(r.args).toContain("--resume");
    expect(r.args).not.toContain("--session-id");
  });

  it("任何 agent 的命令里都不出现 --session-id", () => {
    for (const a of ALL) {
      expect(resumeCommand(session(a)).args, a).not.toContain("--session-id");
    }
  });

  it("在会话自己的真实工作目录下恢复", () => {
    const cwd = "C:\\Users\\PC\\Desktop\\Recent\\KnowledgeBase";
    expect(resumeCommand(session("claude", { cwd })).cwd).toBe(cwd);
  });

  it("工作目录已消失时拒绝，错误里带上那个路径", () => {
    const gone = "C:\\Users\\PC\\AppData\\Local\\Temp\\没了";
    for (const a of ALL) {
      expect(() => resumeCommand(session(a, { cwd: gone, cwdExists: false })), a).toThrow(gone);
    }
  });

  it("工作目录未知时拒绝，且说明是未知而不是不存在", () => {
    expect(() => resumeCommand(session("claude", { cwd: null, cwdExists: false }))).toThrow(/未知/);
  });

  it("拒绝时不回退到任何别的目录 —— 只抛错，不返回结果", () => {
    // 在错的目录下恢复，轻则找不到会话，重则在别的项目里开出一个新会话
    expect(() => resumeCommand(session("claude", { cwd: null, cwdExists: false }))).toThrow();
    expect(() => resumeCommand(session("claude", { cwd: "C:\\gone", cwdExists: false }))).toThrow();
  });

  it("会话 id 原样传递，不做任何截断或改写", () => {
    const id = "019fd3f3-2075-74f1-b4a4-9ff06de4be90";
    for (const a of ALL) {
      expect(resumeCommand(session(a, { sessionId: id })).args, a).toContain(id);
    }
  });
});
