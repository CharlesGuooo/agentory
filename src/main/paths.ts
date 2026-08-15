import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 五个 agent 的存储路径，**收在这一处**。
 *
 * ## 为什么要有这个文件
 *
 * 在它之前，`join(homedir(), ".claude", …)` 这样的写死路径散在 15 个地方
 * （`sessions/` 五个扫描器 + `harness/` 的十处）。它们是整个产品的地基：
 * 一处在别人机器上不成立，那个 agent 就静默显示成「没有」——
 * 而且是「你没装」而不是「我们找不到」。**看起来一切正常，才是最糟的失败模式。**
 *
 * ## 为什么是「候选列表」而不是「一条规则」
 *
 * 因为我们对每条规则的把握程度不一样。已经查实的：
 *
 * | agent | 覆盖变量 | 证据 |
 * |---|---|---|
 * | claude | `CLAUDE_CONFIG_DIR` | 官方文档 + `claude.exe` 里的字符串 |
 * | codex | `CODEX_HOME` | codex 二进制里的 `$CODEX_HOME/skills` |
 * | opencode | `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` | `opencode.exe` 里四个都在 |
 * | grok | `GROK_HOME` / `XDG_CONFIG_HOME` | `grok.exe` |
 * | pi | **没找到** | 包和二进制里都没有 —— 没找到就不编一个 |
 *
 * 但**细节仍有不确定**：比如 `CLAUDE_CONFIG_DIR` 会不会把 `~/.claude.json`
 * 一起搬走（它是 `~/.claude` 的兄弟不是子目录），文档没说清。
 *
 * 「按顺序试，取第一个存在的」让我们**不必赌对** —— 只要候选里包含正确答案就找得到。
 * 而 `tried` 把试过的路径都留下来，诊断面板据此说「我们找了这几个地方」，
 * 而不是干巴巴一句「没有」。
 */

export interface Resolved {
  /** 找到的那个。都不存在时是**第一个候选** —— 界面才说得出「我们期望它在这里」。 */
  path: string;
  /** 依次试过的路径。诊断面板显示它。 */
  tried: string[];
  found: boolean;
  /** 命中的是哪个环境变量。走默认位置就是 null。 */
  via: string | null;
}

export interface Candidate {
  path: string;
  /** 这个候选来自哪个环境变量。默认位置是 null。 */
  via: string | null;
}

/** 按顺序试，取第一个存在的。`exists` 可注入是为了测试。 */
export function resolveFirst(
  candidates: Candidate[],
  exists: (p: string) => boolean = existsSync,
): Resolved {
  // 空串的环境变量当没设，不让它变成一个空路径候选
  const list = candidates.filter((c) => c.path.trim() !== "");
  const tried = list.map((c) => c.path);
  const hit = list.find((c) => exists(c.path));
  const first = list[0];
  return {
    path: hit?.path ?? first?.path ?? "",
    tried,
    found: hit !== undefined,
    via: (hit ?? first)?.via ?? null,
  };
}

type Env = Record<string, string | undefined>;

/** 环境变量的值，空白当没设。 */
const ev = (env: Env, name: string): string => (env[name] ?? "").trim();

/** `<环境变量指定的目录>` 这个候选，没设就不产生候选。 */
const fromEnv = (env: Env, name: string, ...sub: string[]): Candidate[] => {
  const v = ev(env, name);
  return v === "" ? [] : [{ path: join(v, ...sub), via: name }];
};

export interface AgentPaths {
  claude: { configDir: Resolved; claudeJson: Resolved };
  codex: { home: Resolved };
  opencode: { configDir: Resolved; dataDir: Resolved };
  grok: { home: Resolved };
  pi: { agentDir: Resolved };
}

/**
 * 解析五个 agent 的存储根。
 *
 * `home` / `env` / `exists` 可注入是为了**在临时目录里造出「别人的机器」**来跑真测试 ——
 * 这比想象别人的机器长什么样可靠得多。
 */
export function agentPaths(
  home: string = homedir(),
  env: Env = process.env,
  exists: (p: string) => boolean = existsSync,
): AgentPaths {
  const r = (c: Candidate[]): Resolved => resolveFirst(c, exists);
  const home1 = (...sub: string[]): Candidate => ({ path: join(home, ...sub), via: null });

  return {
    claude: {
      configDir: r([...fromEnv(env, "CLAUDE_CONFIG_DIR"), home1(".claude")]),
      // `.claude.json` 是 `.claude` 的兄弟。CLAUDE_CONFIG_DIR 会不会把它一起搬走
      // 文档没说清，所以两个都试 —— 不必赌对。
      claudeJson: r([
        ...fromEnv(env, "CLAUDE_CONFIG_DIR", ".claude.json"),
        home1(".claude.json"),
      ]),
    },
    codex: { home: r([...fromEnv(env, "CODEX_HOME"), home1(".codex")]) },
    opencode: {
      configDir: r([
        ...fromEnv(env, "OPENCODE_CONFIG_DIR"),
        ...fromEnv(env, "XDG_CONFIG_HOME", "opencode"),
        home1(".config", "opencode"),
      ]),
      // 会话库（opencode.db）在数据目录，不在配置目录
      dataDir: r([
        ...fromEnv(env, "XDG_DATA_HOME", "opencode"),
        home1(".local", "share", "opencode"),
      ]),
    },
    grok: {
      home: r([
        ...fromEnv(env, "GROK_HOME"),
        ...fromEnv(env, "XDG_CONFIG_HOME", "grok"),
        home1(".grok"),
      ]),
    },
    // pi 的包和二进制里都没找到覆盖变量。**没找到就不编一个。**
    pi: { agentDir: r([home1(".pi", "agent")]) },
  };
}
