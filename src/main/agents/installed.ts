import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCommand, type ResolvedCommand } from "../terminal/resolve";
import type { AgentId } from "../sessions/types";

/**
 * 本机装了哪些 agent、各是什么版本。
 *
 * ## 为什么不跑 `<agent> --version`
 *
 * 因为**根本不用起进程**：四个 agent 走 npm，版本就写在它们自己的 `package.json` 里；
 * grok 是独立二进制，版本写在它自带的 `CHANGELOG.md` 首行。全部是文件读，毫秒级。
 *
 * 而「不起 agent 进程」不只是快 —— 这个项目最贵的一次事故就是探针碰了 agent 的 TUI：
 * `/help` + 回车在 codex 的升级对话框上选中了「立即更新」，把 codex 卸掉重装
 * （`openspec/changes/prototype-terminal-fidelity/findings.md:130-137`）。
 * grok 的二进制里同样有 `Update now? [Y/n/d]`，是同一类地雷。
 * 能用读文件回答的问题，就不要用起进程去问。
 */

/** 往上走几层就放弃。够覆盖 `<pkg>/bin/x.exe` 和 `<pkg>/dist/cli.js`，又不会走到磁盘根。 */
const MAX_UP = 6;

/** 从 `start` 所在目录往上逐层找，命中就返回。 */
function walkUp<T>(start: string, probe: (dir: string) => T | null): T | null {
  let dir = dirname(start);
  for (let i = 0; i < MAX_UP; i++) {
    const hit = probe(dir);
    if (hit !== null) return hit;
    const up = dirname(dir);
    if (up === dir) break; // 到根了
    dir = up;
  }
  return null;
}

export interface PackageInfo {
  name: string | null;
  version: string;
}

/**
 * 从可执行文件往上找到的**第一个**带 `version` 的 `package.json`。
 *
 * 「第一个」很重要：外层往往还有别的 `package.json`（比如 npm 自己的），
 * 拿错了就会显示成完全不相干的版本号。
 */
export function packageJsonUp(exePath: string): PackageInfo | null {
  return walkUp(exePath, (dir) => {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return null;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { name?: unknown; version?: unknown };
      if (typeof j.version !== "string" || !j.version) return null;
      return { name: typeof j.name === "string" ? j.name : null, version: j.version };
    } catch {
      // 坏 JSON 不该让整个版本检测失败 —— 当成没找到，继续往上
      return null;
    }
  });
}

/** CHANGELOG 首行形如 `# 0.2.118 — 2026-07-31`，取出版本那一段。 */
const CHANGELOG_HEAD = /^#\s*v?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?)\b/;

/**
 * 从可执行文件往上找 `CHANGELOG.md`，读首行的版本号。
 *
 * 这是给 grok 这类**不走包管理器**的独立二进制用的。
 * 本机交叉验证过：`~/.grok/CHANGELOG.md` 首行是 `# 0.2.118`，
 * 而 `grok.exe` 里紧挨着 `currentVersion` 的字面量也是 `0.2.118 (1e1687c1cf)`，两处一致。
 */
export function changelogUp(exePath: string): string | null {
  return walkUp(exePath, (dir) => {
    const p = join(dir, "CHANGELOG.md");
    if (!existsSync(p)) return null;
    try {
      // 只读开头一小段，changelog 可能很长
      const head = readFileSync(p, "utf8").slice(0, 200).split(/\r?\n/, 1)[0] ?? "";
      return CHANGELOG_HEAD.exec(head)?.[1] ?? null;
    } catch {
      return null;
    }
  });
}

/**
 * `~/.grok/downloads/grok-1.0.5-windows-x86_64` —— 目录名里就带着装上去的版本。
 *
 * 只认纯 `数字.数字…`，**不认预发布后缀**：`-windows` 和 `-beta.1` 在这个名字里
 * 长得一模一样，允许后缀就会把平台名当成版本的一部分（第一版正则就是这么写的，
 * 结果真机上读出 `1.0.5-windows`）。真碰上预发布版会退化成丢掉后缀的 `1.1.0`，
 * 那是「少一截」，不是「多一截平台名」。
 */
const DOWNLOAD_ENTRY = /^grok-v?(\d+(?:\.\d+)+)(?:-|$)/;

/**
 * 从 `downloads/` 里读 grok **真正装上去**的版本。
 *
 * ## 为什么需要它：CHANGELOG.md 在自更新之后是错的
 *
 * 本机实测（2026-08-19）：`grok update` 把 `bin/grok.exe` 从 0.2.118 换成了 1.0.5
 * （140687688 → 142651720 字节），同时写了 `version.json` 和
 * `downloads/grok-1.0.5-windows-x86_64`，**唯独没碰 `CHANGELOG.md`** ——
 * 那份是**安装器**写的，自更新器不管。所以只读 CHANGELOG 会永远停在旧版本上，
 * 「有新版」的按钮永远消不掉。
 *
 * 排除掉的另外两个来源：
 * - `version.json`：里面 `version` 和 `stable_version` 并列、还带 `checked_at`，
 *   那是**渠道上的可用版本**缓存（已装版本不可能有两个版本号）；
 *   而且实测「只查不装」的一次 `grok update` 也会重写它。拿它当已装版本会反过来
 *   谎称「已是最新」，把真的更新藏起来 —— 比显示旧版本更坏。
 * - `grok.exe` 的 PE 版本资源：实测是空的（Bun 打包的单文件 exe 不带 VERSIONINFO）。
 *
 * **已知的缺口**：如果用户拿安装器**降级**回旧版，安装器不写 `downloads/grok-<版本>-`，
 * 这里会继续报那个更高的版本，直到下一次自更新。降级是罕见路径，不为它加机制。
 */
export function downloadsUp(exePath: string): string | null {
  return walkUp(exePath, (dir) => {
    const d = join(dir, "downloads");
    if (!existsSync(d)) return null;
    try {
      let best: { version: string; at: number } | null = null;
      for (const name of readdirSync(d)) {
        const v = DOWNLOAD_ENTRY.exec(name)?.[1];
        if (v === undefined) continue;
        // 取**最后装的**那次，不是版本号最大的那个 —— 语义是「现在装着什么」
        const at = statSync(join(d, name)).mtimeMs;
        if (best === null || at > best.at) best = { version: v, at };
      }
      return best?.version ?? null;
    } catch {
      return null; // 读不了就当没有，回落 CHANGELOG
    }
  });
}

export interface Installed {
  agent: AgentId;
  /** 读不出来就是 null —— 界面显示「版本未知」，**不猜**。 */
  version: string | null;
  /** npm 包名。更新命令要用它，所以不写死。非 npm 装的就是 null。 */
  pkg: string | null;
  /** 版本是从哪读出来的。出问题时定位用。 */
  from: string;
}

const ALL: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

/**
 * 一个 agent 的版本。
 *
 * **要看的是 `args[0] ?? exe`**：codex / pi 的 shim 走 node 跑一个 `.js`，
 * 这时 `exe` 是 node 自己，往上走只会找到 node 的目录 —— 真正的包在脚本那一侧。
 */
function versionOf(agent: AgentId, r: ResolvedCommand): Installed {
  const target = r.args[0] ?? r.exe;

  const pkg = packageJsonUp(target);
  if (pkg) return { agent, version: pkg.version, pkg: pkg.name, from: "package.json" };

  // downloads/ 在 CHANGELOG.md 之前：自更新之后只有前者是对的（见 `downloadsUp` 的注释）
  const dl = downloadsUp(target);
  if (dl) return { agent, version: dl, pkg: null, from: "downloads/" };

  const cl = changelogUp(target);
  if (cl) return { agent, version: cl, pkg: null, from: "CHANGELOG.md" };

  return { agent, version: null, pkg: null, from: `读不出：${target}` };
}

/**
 * 本机装了的 agent 及其版本。没装的不出现在结果里。
 *
 * `resolve` 可注入是为了测试；生产上必须是 `resolveCommand` —— 用**同一个解析器**，
 * 两套判定会分叉，那时列表里就会出现「显示装了但启动不了」的项（见 `launch.ts` 的注释）。
 */
export function installedVersions(resolve: (name: string) => ResolvedCommand = resolveCommand): Installed[] {
  const out: Installed[] = [];
  for (const agent of ALL) {
    try {
      out.push(versionOf(agent, resolve(agent)));
    } catch {
      // 解析不出来 = 没装。不是错误。
    }
  }
  return out;
}
