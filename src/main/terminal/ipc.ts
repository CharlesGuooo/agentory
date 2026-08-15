import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow } from "electron";
import { resolveCommand } from "./resolve";
import { spawnSession, type PtySession } from "./session";

/** id → 活着的会话。id 由主进程分配，渲染进程只拿到字符串。 */
const sessions = new Map<string, PtySession>();

export interface SpawnRequest {
  command: string;
  /** 追加在解析结果之后。恢复会话要用（如 `claude --resume <id>`）。 */
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
}

export interface SpawnResult {
  id: string;
  pid: number;
  /** 实际起的可执行文件 —— shim 解析的结果，出问题时要能看见 */
  exe: string;
}

/**
 * 起一个受管会话：解析命令 → 起 PTY → 注册进表 → 把输出转发给渲染层。
 *
 * 抽出来是因为「新建会话」和「恢复历史会话」都要走它 ——
 * 各写一遍会让会话注册表分裂成两套，退出清理就会漏。
 */
export function spawnManaged(
  req: SpawnRequest,
  getWindow: () => BrowserWindow | null,
): SpawnResult {
  const resolved = resolveCommand(req.command);
  const session = spawnSession({
    command: resolved.exe,
    args: [...resolved.args, ...(req.args ?? [])],
    cwd: req.cwd,
    cols: req.cols,
    rows: req.rows,
    // 解析器要求补的环境变量（回落到 electron 当 node 用时的 ELECTRON_RUN_AS_NODE）
    ...(resolved.env ? { env: { ...process.env, ...resolved.env } } : {}),
  });
  const id = randomUUID();
  sessions.set(id, session);

  session.onData((chunk) => {
    getWindow()?.webContents.send("terminal:data", { id, chunk });
  });
  session.onExit((info) => {
    sessions.delete(id);
    getWindow()?.webContents.send("terminal:exit", { id, ...info });
  });

  return { id, pid: session.pid, exe: resolved.exe };
}

export function registerTerminalIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle("terminal:spawn", (_e, req: SpawnRequest): SpawnResult =>
    spawnManaged(req, getWindow),
  );

  ipcMain.on("terminal:write", (_e, p: { id: string; data: string }) => {
    sessions.get(p.id)?.write(p.data);
  });
  ipcMain.on("terminal:resize", (_e, p: { id: string; cols: number; rows: number }) => {
    sessions.get(p.id)?.resize(p.cols, p.rows);
  });
  ipcMain.on("terminal:kill", (_e, p: { id: string }) => {
    sessions.get(p.id)?.kill();
  });
}

/** 当前活着的会话 PID。用来验证"结束会话"真的把进程树带走了。 */
export const livePids = (): number[] => [...sessions.values()].map((s) => s.pid);

/** 应用退出时调用 —— 规格要求"应用关闭后不留孤儿进程"。 */
export function killAllSessions(): void {
  for (const s of sessions.values()) s.kill();
  sessions.clear();
}
