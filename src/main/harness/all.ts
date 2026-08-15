import {
  claudeMcpSources,
  codexMcpPath,
  grokMcpPath,
  openCodeMcpPath,
  readCodexMcp,
  readGrokMcp,
  readOpenCodeMcp,
  type McpResult,
} from "./mcp";
import { readSkills, skillsRoot } from "./skills";
import { ALL_AGENTS, type AgentId } from "../sessions/types";
import type { HarnessMatrix, HarnessSource, McpRow, Scope, SkillRow } from "./types";

/**
 * 把五个 agent 的读取结果拼成一张矩阵。
 *
 * 读取器保持成**数组字面量**，不抽接口 —— 照 `sessions/all.ts` 的先例（D-11）。
 */

interface McpSource {
  agent: AgentId;
  path: string;
  result: McpResult;
}

/**
 * 每个 agent 的 MCP 来源。
 *
 * **pi 在这里有一条明确的 `unsupported` 记录，不是从数组里省略。**
 * 缺席是要靠人记住的事实；一条写着「不支持」的记录是代码携带的事实。
 * 界面上 pi 那一列因此是一整列「—」，而不是一整列空白 —— 后者会被读成「都没配」。
 */
function mcpSources(): McpSource[] {
  return [
    ...claudeMcpSources().map((s) => ({ agent: "claude" as const, path: s.path, result: s.result })),
    { agent: "codex" as const, path: codexMcpPath(), result: readCodexMcp() },
    { agent: "opencode" as const, path: openCodeMcpPath(), result: readOpenCodeMcp() },
    {
      agent: "pi" as const,
      path: "",
      result: {
        entries: [],
        state: "unsupported" as const,
        // pi 的 README：`**No MCP.** Build CLI tools with READMEs (see Skills)`
        note: "pi 不支持 MCP —— 它的文档建议改用 skills 包 CLI 工具",
      },
    },
    { agent: "grok" as const, path: grokMcpPath(), result: readGrokMcp() },
  ];
}

/** 按名字聚合成矩阵行。行是**名字**，格子里放各 agent 自己那套翻译过来的记录。 */
function toMcpRows(sources: McpSource[]): McpRow[] {
  const byName = new Map<string, McpRow>();
  for (const s of sources) {
    for (const e of s.result.entries) {
      let row = byName.get(e.name);
      if (!row) {
        row = { name: e.name, byAgent: {} };
        byName.set(e.name, row);
      }
      // 数组：同一个 agent 可能在多个文件里定义同名服务器（claude 实测就是）
      (row.byAgent[s.agent] ??= []).push(e);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 扫一个作用域下的全部 harness。**纯读，不写任何文件。** */
export function scanHarness(scope: Scope): HarnessMatrix {
  const sources: HarnessSource[] = [];
  const problems: string[] = [];

  // ---- MCP：只有全局作用域读。项目级 MCP 只有 claude/grok 支持，v1 不做 ----
  const mcp: McpSource[] = scope.kind === "global" ? mcpSources() : [];
  for (const s of mcp) {
    sources.push({
      agent: s.agent,
      kind: "mcp",
      path: s.path,
      state: s.result.state,
      count: s.result.entries.length,
      note: s.result.note,
    });
    if (s.result.state === "unreadable") {
      problems.push(`[${s.agent}] MCP 配置读不动：${s.path}${s.result.note ? `（${s.result.note}）` : ""}`);
    }
  }

  // ---- skills：全局和项目级都读 ----
  const skillRows = new Map<string, SkillRow>();
  for (const agent of ALL_AGENTS) {
    const root = skillsRoot(agent, scope);
    const r = readSkills(root);
    sources.push({ agent, kind: "skills", path: root, state: r.state, count: r.entries.length, note: null });
    if (r.state === "unreadable") problems.push(`[${agent}] skills 目录读不动：${root}`);

    for (const e of r.entries) {
      let row = skillRows.get(e.name);
      if (!row) {
        row = { name: e.name, byAgent: {} };
        skillRows.set(e.name, row);
      }
      row.byAgent[agent] = e;
    }
  }

  return {
    mcp: toMcpRows(mcp),
    skills: [...skillRows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    sources,
    problems,
  };
}
