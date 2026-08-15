import { app, ipcMain } from "electron";
import { readSkills, skillsRoot } from "./harness/skills";
import { agentPaths, type Resolved } from "./paths";
import { allScanners } from "./sessions/all";
import { resolveCommand } from "./terminal/resolve";
import { ALL_AGENTS, type AgentId } from "./sessions/types";

/**
 * 诊断信息。
 *
 * ## 它解决的不是 bug，是「客户机器你摸不到」
 *
 * agentory 的整个地基是「五个 agent 的东西在这些路径上」。客户那边一旦不成立
 * （配置目录被环境变量搬走、agent 是原生安装而不是 npm、只装了其中两个），
 * 界面会**静默显示成「你没有」** —— 看起来一切正常，这是最难查的失败模式。
 *
 * 有这一屏：客户复制一段文本给你，你立刻知道是哪一环。
 * 没有：你只能来回问「你能不能跑一下这个命令」，而大多数客户不会配合。
 *
 * ## 里面绝不包含什么
 *
 * **任何文件内容、任何凭证。** 只有路径、找到没找到、数量。
 * 路径里会有用户名（诊断必需），除此之外不含用户的任何数据。
 */

export interface PathRow {
  what: string;
  path: string;
  found: boolean;
  /** 命中的环境变量。走默认位置就是 null。 */
  via: string | null;
  /** 试过几个候选。>1 说明设了环境变量或有回落。 */
  triedCount: number;
}

export interface AgentRow {
  agent: AgentId;
  /** PATH 里解析到的可执行文件。解析不出就是 null（= 没装）。 */
  exe: string | null;
  /** 怎么解析出来的：direct / cmd-shim / cmd-shim-node。 */
  via: string | null;
  sessions: number;
  skills: number;
}

export interface Diagnostics {
  app: { version: string; electron: string; node: string; platform: string };
  paths: PathRow[];
  agents: AgentRow[];
  problems: string[];
}

const row = (what: string, r: Resolved): PathRow => ({
  what,
  path: r.path,
  found: r.found,
  via: r.via,
  triedCount: r.tried.length,
});

export function collectDiagnostics(): Diagnostics {
  const p = agentPaths();
  const paths: PathRow[] = [
    row("claude 配置目录", p.claude.configDir),
    row("claude.json", p.claude.claudeJson),
    row("codex", p.codex.home),
    row("opencode 配置", p.opencode.configDir),
    row("opencode 数据", p.opencode.dataDir),
    row("grok", p.grok.home),
    row("pi", p.pi.agentDir),
  ];

  const problems: string[] = [];
  const agents: AgentRow[] = ALL_AGENTS.map((agent) => {
    let exe: string | null = null;
    let via: string | null = null;
    try {
      const r = resolveCommand(agent);
      exe = r.exe;
      via = r.via;
    } catch {
      // 解析不出来 = 没装。不是错误。
    }
    const scan = allScanners.find((s) => s.agent === agent);
    let sessions = 0;
    try {
      const got = scan?.run();
      sessions = got?.sessions.length ?? 0;
      for (const x of got?.problems ?? []) problems.push(`[${agent}] ${x}`);
    } catch (e) {
      problems.push(`[${agent}] 扫描会话失败：${(e as Error).message}`);
    }
    const skills = readSkills(skillsRoot(agent, { kind: "global" })).entries.length;

    // **装了却一条会话都没有** —— 多半是配置目录不在我们找的地方。
    // 这正是那种「看起来一切正常」的失败，值得主动说出来。
    if (exe !== null && sessions === 0 && skills === 0) {
      problems.push(`[${agent}] PATH 里有它，但会话和 skills 都是 0 —— 配置目录可能不在我们找的位置`);
    }
    return { agent, exe, via, sessions, skills };
  });

  return {
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? "?",
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
    },
    paths,
    agents,
    problems,
  };
}

/** 渲染成一段可以直接贴给维护者的纯文本。 */
export function renderDiagnostics(d: Diagnostics): string {
  const lines = [
    `agentory ${d.app.version} · electron ${d.app.electron} · node ${d.app.node} · ${d.app.platform}`,
    "",
    "路径：",
    ...d.paths.map(
      (r) =>
        `  ${r.found ? "✓" : "✗"} ${r.what.padEnd(16)} ${r.via ? `[${r.via}] ` : ""}${r.path}` +
        (r.triedCount > 1 ? `  （试过 ${r.triedCount} 个）` : ""),
    ),
    "",
    "Agent：",
    ...d.agents.map(
      (a) =>
        `  ${a.agent.padEnd(9)} ${a.exe ? `${a.via} → ${a.exe}` : "PATH 里没有（没装）"}` +
        `  会话 ${a.sessions} · skills ${a.skills}`,
    ),
  ];
  if (d.problems.length > 0) lines.push("", "问题：", ...d.problems.map((p) => `  ⚠ ${p}`));
  return lines.join("\n");
}

/**
 * 只暴露渲染好的文本。
 *
 * 结构化的 `Diagnostics` 不跨 IPC —— 界面要做的事就是把它显示出来、让人复制走，
 * 传一个没人消费的对象只是多一个会漂移的接口。
 */
export function registerDiagnosticsIpc(): void {
  ipcMain.handle("diagnostics:text", (): string => renderDiagnostics(collectDiagnostics()));
}
