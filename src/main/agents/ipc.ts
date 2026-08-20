import { t } from "../../shared/i18n";
import { app, ipcMain, shell, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../sessions/types";
import { spawnManaged } from "../terminal/ipc";
import { isNewer } from "./compare";
import { installedVersions, type Installed } from "./installed";
import { fetchLatest } from "./latest";

/**
 * Agent 版本检测的 IPC。
 *
 * 两条链路，性质完全不同，所以是两个开关：
 * - **读本机版本**：纯文件读，零网络，零进程（见 `installed.ts` 的注释）
 * - **查最新版**：出网，但出去的只有包名，不含任何用户内容（D-8 的第三档）
 */

/** 缓存的新鲜期。6 小时 —— agent 一天发不了几个版本，没必要每次开应用都去问。 */
const FRESH_MS = 6 * 60 * 60 * 1000;

export interface LatestInfo {
  version: string;
  /** 「看更新说明」链接，推不出来就是 null。 */
  url: string | null;
}

interface Cache {
  checkedAt: string;
  byAgent: Partial<Record<AgentId, LatestInfo>>;
}

/**
 * 缓存直接写在这里，不复用 `entryFile.ts`：那份的磁盘格式是 `{version:1, sessions:[…]}`，
 * 套在「一个时间戳 + 一张表」上语义是错的。它的价值在「绝不替用户销毁记录」，
 * 而这里存的是**可以随时重新查到的派生数据**，丢了不心疼。
 */
const cachePath = (): string => join(app.getPath("userData"), "versions.json");

function loadCache(): Cache | null {
  try {
    const p = cachePath();
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8")) as Cache;
    return typeof j.checkedAt === "string" && typeof j.byAgent === "object" ? j : null;
  } catch {
    return null; // 坏了就当没有，重新查一次的代价是零
  }
}

function saveCache(c: Cache): void {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(cachePath(), `${JSON.stringify(c, null, 2)}\n`);
  } catch {
    // 写不进去不影响功能，这一轮的结果还在内存里
  }
}

export interface AgentRow extends Installed {
  latest: string | null;
  releasesUrl: string | null;
  hasUpdate: boolean;
  /** 更新命令。既是可复制的那条，也是点「更新」时我们真正会执行的那条。 */
  updateCommand: string | null;
}

export interface AgentsState {
  rows: AgentRow[];
  /** 上次查最新版的时间，ISO。从没查过就是 null。 */
  checkedAt: string | null;
  checking: boolean;
  /** 查最新版这个开关。 */
  checkEnabled: boolean;
}

interface UpdatePlan {
  command: string;
  args: string[];
  /** 给用户看的那条。它也是「我们要执行什么」的公示，所以和上面两个字段同源。 */
  display: string;
}

/**
 * 这个 agent 怎么更新。npm 包名来自它自己的 `package.json`，**不写死**；
 * grok 不走 npm，用它自带的 `grok update`。
 *
 * **显示和执行必须同源。** 拆成两个函数（一个给字符串、一个给 spawn 参数）时，
 * 两边判的是同一个条件，于是「一边返回 null、另一边没有」的兜底分支永远不可达 ——
 * 那种代码看着像防御，实际是留给两边分叉的入口。
 *
 * **npm 不能走 `resolveCommand`** —— 实测它抛「无法解析」：npm 的 `.cmd` shim
 * 用 `%_prog%` 引用 node，两条分支（找 `.exe` / 找 `.js`）都匹配不到。
 * 所以套一层 `cmd.exe /c`。`resolve.ts` 的注释说套 cmd 会多一个要清理的进程 ——
 * 那条针对的是**长期跑的 agent 会话**；这里是个一次性命令，我们等它退出，代价不成立。
 * grok 在 PATH 里就是 `.exe`，`resolveCommand` 直接命中。
 */
function updateOf(i: Installed): UpdatePlan | null {
  if (i.agent === "grok") return { command: "grok", args: ["update"], display: "grok update" };
  if (i.pkg === null) return null;
  return {
    command: "cmd.exe",
    args: ["/c", "npm", "install", "-g", i.pkg],
    display: `npm install -g ${i.pkg}`,
  };
}

export interface UpdateStart {
  ok: boolean;
  error?: string;
  /** 起更新之前读到的版本。之后要拿它和重读的结果比 —— 只信版本号，不信退出码。 */
  before?: string | null;
  /** 给用户看的那条命令，和面板标题一致 */
  display?: string;
  id?: string;
}

let cache: Cache | null = null;
let checking = false;

type Enabled = { get: () => boolean; set: (v: boolean) => void };

function buildRows(): AgentRow[] {
  return installedVersions().map((i) => {
    const hit = cache?.byAgent[i.agent] ?? null;
    const latest = hit?.version ?? null;
    return {
      ...i,
      latest,
      releasesUrl: hit?.url ?? null,
      // 任一边读不出来就**不声称**有新版 —— 误报会把用户推去做一次没必要的升级
      hasUpdate: latest !== null && i.version !== null && isNewer(latest, i.version),
      updateCommand: updateOf(i)?.display ?? null,
    };
  });
}

/** 真去查一轮。`force` 忽略新鲜期（对应界面上的「现在检查」）。 */
async function refresh(force: boolean): Promise<void> {
  if (checking) return;
  if (!force && cache && Date.now() - new Date(cache.checkedAt).getTime() < FRESH_MS) return;

  checking = true;
  try {
    const list = installedVersions();
    // 五个互不相关，并发。这里没有摘要那种「串行才可续」的理由
    const got = await Promise.all(list.map(async (i) => ({ i, r: await fetchLatest(i) })));

    const byAgent: Partial<Record<AgentId, LatestInfo>> = { ...(cache?.byAgent ?? {}) };
    let any = false;
    for (const { i, r } of got) {
      if (!r.ok) continue; // 失败就保留上一次的值：查不到不该让已知的东西消失
      byAgent[i.agent] = { version: r.version, url: r.url };
      any = true;
    }
    // 一条都没成功（多半是没网）就不要把 checkedAt 往前推，否则会谎称"刚查过"
    if (any) {
      cache = { checkedAt: new Date().toISOString(), byAgent };
      saveCache(cache);
    }
  } finally {
    checking = false;
  }
}

export function registerAgentsIpc(getWindow: () => BrowserWindow | null, checkEnabled: Enabled): void {
  cache = loadCache();

  const state = (): AgentsState => ({
    rows: buildRows(),
    checkedAt: cache?.checkedAt ?? null,
    checking,
    checkEnabled: checkEnabled.get(),
  });

  ipcMain.handle("agents:state", (): AgentsState => state());

  ipcMain.handle("agents:setCheckEnabled", (_e, v: boolean): AgentsState => {
    checkEnabled.set(v);
    return state();
  });

  ipcMain.handle("agents:check", async (): Promise<AgentsState> => {
    if (!checkEnabled.get()) return state();
    await refresh(true);
    return state();
  });

  /**
   * 起一个更新。**只负责起,不负责停会话、不负责重启** —— 那两件事在渲染层，
   * 因为只有它知道哪些面板属于这个 agent。
   *
   * ## 这是在改写 D-15 的一半，理由要写在这里
   *
   * D-15 原本是「显示，不代劳」，起因是 `findings.md:130-137` 那次事故：
   * 探针**盲发** `/help` + 回车，在 codex 的「Update available」对话框上选中了
   * 「立即更新」，把 codex 卸掉重装并留下缺失的 shim。
   *
   * **那次的错不在「代跑」，在「盲发按键 + 用户看不见」。** 这里恰好把两点都反过来：
   * 命令是我们按 `package.json` 里的包名明确构造的（不是撞到的），
   * 而且**跑在一个用户看得见的终端面板里** —— npm 要是问什么，用户能回答。
   *
   * 仍然保留的那一半：**不起 agent 进程去问版本**（`installed.test.ts` 那条
   * 「只许起 where.exe」的断言继续守着 `installedVersions()`）。
   */
  ipcMain.handle(
    "agents:startUpdate",
    (_e, agent: AgentId, cols: number, rows: number): UpdateStart => {
      const i = installedVersions().find((x) => x.agent === agent);
      if (!i) return { ok: false, error: t("ver.notDetected", { agent }) };
      const plan = updateOf(i);
      if (!plan) {
        return { ok: false, error: t("ver.notNpm", { agent }) };
      }
      try {
        const s = spawnManaged({ ...plan, cwd: homedir(), cols, rows }, getWindow);
        return {
          ok: true,
          before: i.version,
          display: plan.display,
          id: s.id,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  /** 「看更新说明」—— 用系统浏览器打开，不在应用里内嵌网页。 */
  ipcMain.handle("agents:openReleases", async (_e, url: string): Promise<void> => {
    // 只放行我们自己推出来的 GitHub releases 地址，不接受渲染层传任意 URL
    if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases$/.test(url)) await shell.openExternal(url);
  });

  /**
   * 启动后台跑一轮。**在窗口显示之后调**，绝不阻塞启动。
   * 有新版就通知渲染层去点亮齿轮上的小圆点。
   */
  void (async () => {
    if (!checkEnabled.get()) return;
    await refresh(false);
    const n = buildRows().filter((r) => r.hasUpdate).length;
    if (n > 0) getWindow()?.webContents.send("agents:update-available", n);
  })().catch((e: unknown) => {
    // 查版本失败不该变成 unhandled rejection。`fetchLatest` 自己已经不抛了，
    // 但缓存写盘会（盘满、userData 只读）—— 那种时候用户要的是应用照常能用。
    process.stdout.write(`[agents] 后台查版本失败：${String(e)}\n`);
  });
}
