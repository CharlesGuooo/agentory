/**
 * 传给 agent 子进程的环境变量清洗。
 *
 * ## 为什么必须清
 *
 * 实测（Q10）：从一个 Claude Code 会话里启动 agentory 时，`process.env` 里带着
 * `CLAUDE_CODE_CHILD_SESSION`。它原样传给子进程后，**新起的 claude 会关掉
 * transcript 保存** —— 而那正是这个产品要索引的全部内容。
 *
 * 也就是说：不清洗的话，agentory 会亲手销毁它赖以存在的数据。
 *
 * ## 为什么是剔除名单而不是白名单
 *
 * 白名单看起来更安全，但在 Windows 上漏一个就可能让 agent 起不来或行为异常
 * （`HTTP_PROXY`、`LANG`、`NODE_OPTIONS`、公司的证书路径…），而那类 bug 极难诊断。
 * 我们要挡的是一类**明确的东西**：agent 私有的会话级 / 运行时标记。
 *
 * ## 剔什么、不剔什么
 *
 * 只剔**运行时标记**，保留看起来像用户配置的。分不出「用户自己设的」和
 * 「父进程注入的」是这道题唯一的难点，所以按名字的形状判断：
 * 带 SESSION / ENTRYPOINT / EXECPATH / PID / EFFORT 的是运行时，
 * 而 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 这种是配置，保留。
 */

/** 五个 agent 的变量前缀。只有带这些前缀的才可能被剔。 */
const AGENT_PREFIX = /^(CLAUDE|CODEX|OPENCODE|GROK|PI)_/;

/** 运行时 / 会话级标记的名字特征。带这些词的才剔。 */
const RUNTIME_MARK = /(SESSION|ENTRYPOINT|EXECPATH|PID|EFFORT)/;

/**
 * 不符合前缀规则、只能逐个列的标记。
 *
 * `AI_AGENT` 是**做真机验证时才发现的** —— 它的值直接写着父 agent 的身份与版本
 * （`claude-code_2-1-220_agent`），是同一类污染，但名字上完全看不出属于哪个 agent。
 * 这说明前缀规则挡不住全部，名单还得继续长。
 */
const BARE_MARKS = new Set(["CLAUDECODE", "AI_AGENT"]);

/** 这个变量是不是父 agent 注入的运行时标记。 */
export const isAgentRuntimeVar = (name: string): boolean =>
  BARE_MARKS.has(name) || (AGENT_PREFIX.test(name) && RUNTIME_MARK.test(name));

/**
 * 清洗一份环境变量。
 *
 * **返回新对象，不改动入参** —— 入参多半是 `process.env`，改它等于改整个进程。
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isAgentRuntimeVar(k)) out[k] = v;
  }
  return out;
}
