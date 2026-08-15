import { clipboard, contextBridge, ipcRenderer, shell } from "electron";
import type { LaunchOptions, LaunchRequest, ResumeRequest } from "../main/sessions/ipc";
import type { AgentId } from "../main/sessions/types";
import type { SummaryState, SummaryText } from "../main/summary/ipc";
import type { FavoritesState } from "../main/favorites/ipc";
import type { Favorites, FavoriteEntry } from "../main/favorites/model";
import type { RestoreRequest, WorkspaceState } from "../main/workspace/ipc";
import type { Workspace, WorkspaceEntry } from "../main/workspace/model";
import type { RestoreOutcome } from "../main/workspace/restore";
import type { ScanResult, Session } from "../main/sessions/types";
import type { ThemeState } from "../main/theme/service";
import type { ModeSetting } from "../shared/theme";

export interface SpawnRequest {
  command: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
}
export interface SpawnResult {
  id: string;
  pid: number;
  exe: string;
}
export interface ExitInfo {
  exitCode: number;
}

// 唯一的渲染进程 ↔ 主进程通道。
// 只放白名单方法，绝不暴露 ipcRenderer 本身或任何 Node API ——
// 一旦暴露通用的 invoke/on，contextIsolation 就形同虚设。
const api = {
  /** 默认要起的命令。用 AGENTORY_COMMAND 覆盖，例如 `AGENTORY_COMMAND=claude npm start`。 */
  defaultCommand: process.env["AGENTORY_COMMAND"] ?? "cmd.exe",
  defaultCwd: process.env["AGENTORY_CWD"] ?? process.cwd(),

  spawn: (req: SpawnRequest): Promise<SpawnResult> => ipcRenderer.invoke("terminal:spawn", req),
  write: (id: string, data: string): void => ipcRenderer.send("terminal:write", { id, data }),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send("terminal:resize", { id, cols, rows }),
  kill: (id: string): void => ipcRenderer.send("terminal:kill", { id }),

  onData: (cb: (id: string, chunk: string) => void): (() => void) => {
    const h = (_e: unknown, p: { id: string; chunk: string }): void => cb(p.id, p.chunk);
    ipcRenderer.on("terminal:data", h);
    return () => void ipcRenderer.off("terminal:data", h);
  },
  /** 工作集：用户策展的会话集合，跨重启保留。 */
  workspaceState: (): Promise<WorkspaceState> => ipcRenderer.invoke("workspace:state"),
  workspaceAdd: (entry: WorkspaceEntry): Promise<Workspace> =>
    ipcRenderer.invoke("workspace:add", entry),
  workspaceRemove: (agent: AgentId, sessionId: string | null, cwd: string): Promise<Workspace> =>
    ipcRenderer.invoke("workspace:remove", { agent, sessionId, cwd }),
  /** 批量恢复。主进程串行执行，过程通过 onWorkspaceStarted / onWorkspaceProgress 回传。 */
  workspaceRestoreAll: (entries: WorkspaceEntry[], cols: number, rows: number): Promise<RestoreOutcome[]> =>
    ipcRenderer.invoke("workspace:restoreAll", { entries, cols, rows } satisfies RestoreRequest),
  onWorkspaceStarted: (
    cb: (p: { entry: WorkspaceEntry; spawned: SpawnResult }) => void,
  ): (() => void) => {
    const h = (_e: unknown, p: { entry: WorkspaceEntry; spawned: SpawnResult }): void => cb(p);
    ipcRenderer.on("workspace:started", h);
    return () => void ipcRenderer.off("workspace:started", h);
  },
  onWorkspaceProgress: (cb: (done: number, total: number) => void): (() => void) => {
    const h = (_e: unknown, p: { done: number; total: number }): void => cb(p.done, p.total);
    ipcRenderer.on("workspace:progress", h);
    return () => void ipcRenderer.off("workspace:progress", h);
  },

  /** 收藏夹：用户留着以后用的历史会话。与工作集正交 —— 收藏不等于在跑。 */
  favoritesState: (): Promise<FavoritesState> => ipcRenderer.invoke("favorites:state"),
  favoriteAdd: (entry: FavoriteEntry): Promise<Favorites> =>
    ipcRenderer.invoke("favorites:add", entry),
  favoriteRemove: (agent: AgentId, sessionId: string): Promise<Favorites> =>
    ipcRenderer.invoke("favorites:remove", { agent, sessionId }),

  /** 新建会话选择器要的数据：本机可用的 agent + 来自索引的目录候选。 */
  launchOptions: (): Promise<LaunchOptions> => ipcRenderer.invoke("launch:options"),
  /** 打开系统的目录选择对话框。用户取消返回 null。 */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("launch:pickFolder"),
  /** 新建一个会话。目录不存在时 reject，错误信息可直接展示。 */
  startSession: (agent: AgentId, cwd: string, cols: number, rows: number): Promise<SpawnResult> =>
    ipcRenderer.invoke("launch:start", { agent, cwd, cols, rows } satisfies LaunchRequest),

  /** 扫描五个 agent 的全部历史会话。每次调用都是一次全量重扫。 */
  listSessions: (): Promise<ScanResult> => ipcRenderer.invoke("sessions:list"),
  /** 恢复一条历史会话。工作目录不可用时会 reject，错误信息可直接展示。 */
  resumeSession: (session: Session, cols: number, rows: number): Promise<SpawnResult> =>
    ipcRenderer.invoke("sessions:resume", { session, cols, rows } satisfies ResumeRequest),

  /**
   * agent 敲了铃（xterm.js 的 onBell 解析出来的）。
   * 是否真的弹系统通知由主进程决定 —— 它才知道窗口有没有焦点。
   */
  notifyBell: (label: string): void => ipcRenderer.send("notify:bell", { label }),

  /** 摘要（D-7 第 1 层）。**默认关**，生成摘要 = 内容出境（D-8）。 */
  summaryState: (): Promise<SummaryState> => ipcRenderer.invoke("summary:state"),
  summarySetEnabled: (v: boolean): Promise<SummaryState> =>
    ipcRenderer.invoke("summary:setEnabled", v),
  summarySetKey: (k: string): Promise<SummaryState> => ipcRenderer.invoke("summary:setKey", k),
  summaryAll: (): Promise<SummaryText[]> => ipcRenderer.invoke("summary:all"),
  /** 拿一条真会话渲染**过滤后的真实请求体** —— 把「不会偷偷发源码」变成可验证的事实。 */
  summaryPreview: (agent: AgentId, sessionId: string): Promise<string> =>
    ipcRenderer.invoke("summary:preview", { agent, sessionId }),
  summaryRun: (refs: { agent: AgentId; sessionId: string }[]): Promise<{ ok: number; failed: number; error?: string }> =>
    ipcRenderer.invoke("summary:run", refs),
  summaryStop: (): Promise<void> => ipcRenderer.invoke("summary:stop"),
  onSummaryProgress: (
    cb: (p: { done: number; total: number; ok: number; failed: number; last: string }) => void,
  ): (() => void) => {
    const h = (_e: unknown, p: { done: number; total: number; ok: number; failed: number; last: string }): void => cb(p);
    ipcRenderer.on("summary:progress", h);
    return () => void ipcRenderer.off("summary:progress", h);
  },

  /** 右键菜单要用的两件小事。`clipboard` / `shell` 在 preload 里可直接用，不必绕一趟 IPC。 */
  copy: (text: string): void => clipboard.writeText(text),
  openFolder: (dir: string): Promise<string> => shell.openPath(dir),

  /** 让原生窗口控件跟着主题换色。 */
  setWindowOverlay: (color: string, symbolColor: string): void =>
    ipcRenderer.send("window:overlay", { color, symbolColor }),

  themeState: (): Promise<ThemeState> => ipcRenderer.invoke("theme:state"),
  setTheme: (patch: { themeId?: string; mode?: ModeSetting }): Promise<ThemeState> =>
    ipcRenderer.invoke("theme:set", patch),
  onThemeChanged: (cb: (s: ThemeState) => void): (() => void) => {
    const h = (_e: unknown, s: ThemeState): void => cb(s);
    ipcRenderer.on("theme:changed", h);
    return () => void ipcRenderer.off("theme:changed", h);
  },

  onExit: (cb: (id: string, info: ExitInfo) => void): (() => void) => {
    const h = (_e: unknown, p: { id: string } & ExitInfo): void => cb(p.id, { exitCode: p.exitCode });
    ipcRenderer.on("terminal:exit", h);
    return () => void ipcRenderer.off("terminal:exit", h);
  },
} as const;

contextBridge.exposeInMainWorld("agentory", api);

export type AgentoryApi = typeof api;
