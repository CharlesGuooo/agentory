import type { AgentId } from "../sessions/types";

/**
 * 五个 agent 的 harness（skills + MCP）对照矩阵的类型。
 *
 * **纯类型，零运行时 import** —— 渲染层要 import 它，一旦带进 `node:fs` 就炸
 * （照 `sessions/types.ts` 的先例）。
 *
 * ## 一条贯穿整个模型的原则：只统一 key，不统一 record
 *
 * 五套配置唯一真正共有的东西是**标识符** —— MCP 的服务器名、skill 的目录名。
 * 那不是我们发明的抽象，是用户自己敲的、agent 自己用的身份。
 * 所以矩阵的**行是名字**，而每个格子里放的是那个 agent 自己那套字段翻译过来的记录。
 * 造一个「五合一」的配置对象才是假抽象（D-11）。
 */

/**
 * 服务器怎么跑。四个 agent 用四套字段名说的是**同一件事**
 * （MCP 协议自己定义的两种 transport），所以这是**翻译，不是抽象**：
 *
 * | agent | 怎么表达 |
 * |---|---|
 * | claude | `type:"http"` 或有 `command` |
 * | codex | 有 `url` 或有 `command` |
 * | opencode | `type:"remote"` / `"local"` |
 * | grok | 有 `command` |
 */
export type McpTarget =
  /** `argv[0]` 是程序，其余是参数。这是 opencode 的 `command: string[]` 与
      另三家的 `command + args[]` 的**无损公约数** —— argv 就是操作系统实际接受的东西。 */
  | { kind: "stdio"; argv: string[] }
  | { kind: "http"; url: string }
  /** 认不出来。**不猜** —— 出现它就说明有字段形状我们没认出来，真机测试会断言它为 0。 */
  | { kind: "unknown" };

export interface McpEntry {
  name: string;
  target: McpTarget;
  /**
   * **只有配置里直接写着停用才是 `true`；没写是 `null`，不是 `false`。**
   *
   * 「没说」和「说了开」是两件事：各 agent 的缺省语义我们无法校验，
   * 把「没说」渲染成「开着」就是在替它们做主。
   */
  disabledInConfig: boolean | null;
  /**
   * 需要的环境变量**名**。
   *
   * **类型上就装不下值** —— 这是秘密不外泄的结构性保证，不是纪律
   * （照 D-W2：「没有可改的东西，就不可能改错」）。读取器只 `Object.keys()`。
   */
  envNames: string[];
  /** 请求头**名**（`Authorization` 等）。同样只有名字。 */
  headerNames: string[];
  /**
   * 值是**明文字面量**（而不是 `{env:X}` / `$X` 这类占位符）的字段路径，如
   * `headers.Authorization`。只存路径，不存值。
   *
   * 实测本机：claude 有 2 处、opencode 有 3 处明文 token，而 codex / grok 全部走环境变量引用。
   * 这大概是这张矩阵能给出的最可操作的一条信息。
   */
  inlineSecrets: string[];
  /** 哪个文件写的。绝对路径。 */
  source: string;
}

export interface SkillEntry {
  name: string;
  /** 这个 skill 目录的绝对路径。装卸都以它为准。 */
  path: string;
}

/**
 * 一个来源读成了什么。
 *
 * **「空」和「读不到」必须能区分** —— 把读不动显示成 0 条，就是理直气壮地显示错的东西
 * （D-W1：过期/错误的信息比没有信息更糟）。
 */
export type SourceState =
  | "ok"
  | "empty"
  /** 文件/目录不存在 —— 没装，或没配过。不是错误。 */
  | "missing"
  /** 存在但读不动、解析失败。**绝不当成 0 条。** */
  | "unreadable"
  /** 该 agent 根本没这个能力 —— pi 不支持 MCP（README 明写 `No MCP`）。 */
  | "unsupported"
  /** 这个来源被配置显式关掉 —— grok 的 `[compat.claude] mcps = false`。 */
  | "off-by-config";

export interface HarnessSource {
  agent: AgentId;
  kind: "mcp" | "skills";
  path: string;
  state: SourceState;
  count: number;
  /** `state` 非 ok 时给人看的一句话。 */
  note: string | null;
}

export interface McpRow {
  name: string;
  /**
   * **数组，不是单值。** 同一个 agent 可能在多个文件里定义同名服务器 ——
   * claude 实测就是（`~/.claude.json` 与 `~/.claude/settings.json` 重叠 7 个）。
   *
   * **不合并、不选胜者**：合并要求我们知道每个 agent 的优先级规则，
   * 而实测 settings.json 那 17 条一条都没生效，我们无法判定是「不被支持」还是「被盖掉」。
   * 猜就会理直气壮地显示错的东西。两份都列出来并标出来源，两个坑都躲开。
   */
  byAgent: Partial<Record<AgentId, McpEntry[]>>;
}

export interface SkillRow {
  name: string;
  byAgent: Partial<Record<AgentId, SkillEntry>>;
}

export interface HarnessMatrix {
  mcp: McpRow[];
  skills: SkillRow[];
  /** 每个 agent × 每个来源读成了什么。界面顶部的状态条用它。 */
  sources: HarnessSource[];
  problems: string[];
}

/**
 * 作用域：全局，或某个项目目录。
 *
 * 项目级路径各 agent 不同（`.claude/skills/`、`.codex/skills/`…），
 * 由各自的读取器决定，这里只带一个目录。
 */
export type Scope = { kind: "global" } | { kind: "project"; cwd: string };
