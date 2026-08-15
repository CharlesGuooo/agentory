import { app, ipcMain, type BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnManaged, type SpawnResult } from "../terminal/ipc";
import type { AgentId } from "../sessions/types";
import { entryCommand } from "./command";
import {
  addEntry,
  emptyWorkspace,
  entryKey,
  removeEntry,
  type Workspace,
  type WorkspaceEntry,
} from "./model";
import { restoreSerially, type RestoreOutcome } from "./restore";
import { loadWorkspace, saveWorkspace } from "./store";

/** D-6 定的两个文件之一。第二个是摘要缓存，尚未做。 */
const wsPath = (): string => join(app.getPath("userData"), "workspace.json");

export interface WorkspaceState {
  workspace: Workspace;
  /** 读取时被跳过的条目及原因。不静默丢弃用户的记录。 */
  warnings: string[];
  /**
   * 工作目录已不存在的条目 key。
   *
   * **现算，不缓存**（D-W1：工作集不存会过期的字段）。
   * 目录随时可能被删，存下来只会让界面显示过时的判断。
   */
  missingCwd: string[];
}

export interface RestoreRequest {
  entries: WorkspaceEntry[];
  cols: number;
  rows: number;
}

let current: Workspace = emptyWorkspace();
let warnings: string[] = [];

/** 每次变化立即落盘（D-W5，不防抖）—— 防抖会引入「崩溃时丢最后一次变化」的窗口。 */
function commit(next: Workspace): Workspace {
  current = next;
  saveWorkspace(wsPath(), current);
  return current;
}

export function registerWorkspaceIpc(getWindow: () => BrowserWindow | null): void {
  const loaded = loadWorkspace(wsPath());
  current = loaded.workspace;
  warnings = loaded.warnings;

  ipcMain.handle(
    "workspace:state",
    (): WorkspaceState => ({
      workspace: current,
      warnings,
      missingCwd: current.sessions.filter((e) => !existsSync(e.cwd)).map(entryKey),
    }),
  );

  ipcMain.handle("workspace:add", (_e, entry: WorkspaceEntry): Workspace =>
    commit(addEntry(current, entry)),
  );

  ipcMain.handle(
    "workspace:remove",
    (_e, p: { agent: AgentId; sessionId: string | null; cwd: string }): Workspace =>
      commit(removeEntry(current, p.agent, p.sessionId, p.cwd)),
  );

  /**
   * 批量恢复：**串行**。实测负载是 8 个 claude ≈ 上百个子进程，
   * 并行恢复会瞬间打满机器（`docs/research-notes.md` §10）。
   * 编排逻辑在 `restoreSerially` 里，有 7 个测试守着。
   */
  ipcMain.handle("workspace:restoreAll", async (_e, req: RestoreRequest): Promise<RestoreOutcome[]> => {
    return restoreSerially(
      req.entries,
      async (entry) => {
        const c = entryCommand(entry);
        const spawned: SpawnResult = spawnManaged(
          { command: c.command, args: c.args, cwd: c.cwd, cols: req.cols, rows: req.rows },
          getWindow,
        );
        // 每起一个就通知渲染层建面板 —— 用户能看着它们一个个出现
        getWindow()?.webContents.send("workspace:started", { entry, spawned });
      },
      (done, total) => {
        getWindow()?.webContents.send("workspace:progress", { done, total });
      },
    );
  });
}
