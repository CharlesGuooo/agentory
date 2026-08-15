import { app, ipcMain, shell, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../sessions/types";
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
  /** 更新命令。**只给用户复制，永远不由我们执行。** */
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

/**
 * 更新命令。npm 包名来自它自己的 `package.json`，**不写死**。
 * grok 不走 npm，用它自带的 `grok update`。
 */
function updateCommandOf(i: Installed): string | null {
  if (i.agent === "grok") return "grok update";
  return i.pkg === null ? null : `npm install -g ${i.pkg}`;
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
      updateCommand: updateCommandOf(i),
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
  })();
}
