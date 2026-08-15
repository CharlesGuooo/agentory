import { dialog, ipcMain, type BrowserWindow } from "electron";
import { spawnManaged, type SpawnResult } from "../terminal/ipc";
import { resolveCommand } from "../terminal/resolve";
import { availableAgents, folderSuggestions, validateTarget } from "./launch";
import { scanAllAgents } from "./all";
import { resumeCommand } from "./resume";
import type { AgentId, ScanResult, Session } from "./types";

export interface LaunchOptions {
  agents: AgentId[];
  folders: string[];
  /** 判定可用 agent 花了多久（要跑 5 次命令解析），用于确认这一步没有拖慢选择器。 */
  probeMs: number;
}

export interface LaunchRequest {
  agent: AgentId;
  cwd: string;
  cols: number;
  rows: number;
}

export interface ResumeRequest {
  session: Session;
  cols: number;
  rows: number;
}

export function registerSessionsIpc(getWindow: () => BrowserWindow | null): void {
  // 每次都重扫。实测 437 个会话 339 ms —— 按 D-4，不建索引也不做缓存，
  // 而且会话数一直在变（今天就多了 3 个），缓存只会带来"看到的是旧的"这类问题。
  ipcMain.handle("sessions:list", (): ScanResult => scanAllAgents());

  ipcMain.handle("launch:options", (): LaunchOptions => {
    const t0 = performance.now();
    // 用**启动时的同一个解析器** —— 两套判定会分叉，
    // 那时列表里就会出现"选了才发现启动不了"的项
    const agents = availableAgents(resolveCommand);
    const probeMs = performance.now() - t0;
    return { agents, folders: folderSuggestions(scanAllAgents().sessions), probeMs };
  });

  ipcMain.handle("launch:pickFolder", async (): Promise<string | null> => {
    const win = getWindow();
    // 用系统自己的目录对话框 —— 自绘要处理盘符、权限、符号链接、网络路径
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle("launch:start", (_e, req: LaunchRequest): SpawnResult => {
    // 目录不存在就抛 —— 绝不自动创建
    validateTarget(req.cwd);
    return spawnManaged(
      { command: req.agent, cwd: req.cwd, cols: req.cols, rows: req.rows },
      getWindow,
    );
  });

  ipcMain.handle("sessions:resume", (_e, req: ResumeRequest): SpawnResult => {
    // 工作目录不可用时 resumeCommand 会抛错 —— 这里不接住，
    // 让它作为 invoke 的 rejection 传回渲染层显示。
    // 在错的目录下恢复轻则找不到会话，重则在别的项目里开出新会话。
    const cmd = resumeCommand(req.session);
    return spawnManaged(
      { command: cmd.command, args: cmd.args, cwd: cmd.cwd, cols: req.cols, rows: req.rows },
      getWindow,
    );
  });
}
