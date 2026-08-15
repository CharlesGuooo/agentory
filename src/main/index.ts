import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Notification } from "electron";
import { registerAgentsIpc } from "./agents/ipc";
import { registerFavoritesIpc } from "./favorites/ipc";
import { registerSessionsIpc } from "./sessions/ipc";
import { registerSummaryIpc } from "./summary/ipc";
import { attachSmoke, smokeEnabled } from "./smoke";
import { killAllSessions, registerTerminalIpc } from "./terminal/ipc";
import { registerThemeIpc, summariesEnabled, versionCheckEnabled } from "./theme/service";
import { registerWorkspaceIpc } from "./workspace/ipc";

let mainWindow: BrowserWindow | null = null;

/** 顶栏高度。CSS 里的 --titlebar-h 必须与它一致，否则原生控件会错位。 */
const TITLEBAR_HEIGHT = 40;

/**
 * 窗口 / 任务栏图标。
 *
 * 开发态从仓库里的 `resources/` 取；打包后 electron-builder 会把它放进 `resourcesPath`。
 * 找不到就返回 undefined —— 少个图标不该让应用起不来。
 */
function iconPath(): string | undefined {
  for (const p of [
    join(process.resourcesPath, "icon.ico"),
    join(import.meta.dirname, "../../resources/icon.ico"),
  ]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

const icon = iconPath();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    ...(icon ? { icon } : {}),
    // 先给一个接近 GRAPHITE 深色的底，避免窗口出现时闪一下白
    backgroundColor: "#16181D",
    // 藏掉系统标题栏，自己画一条 —— 这是"现代感"的主要来源。
    // titleBarOverlay 让 Windows 把原生的最小化/最大化/关闭画进我们的顶栏，
    // 既保留系统行为（贴边、Snap、双击最大化），又能跟着主题换色。
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#1B1E25", symbolColor: "#7C838F", height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      // 渲染进程拿不到 Node —— 唯一的通道是 preload 用 contextBridge 暴露的那几个方法
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 关掉是为了让 preload 能用 ESM。
      // 真正的边界是 contextIsolation + preload 只暴露白名单方法，见 src/preload/index.ts
      sandbox: false,
    },
  });

  mainWindow = win;
  win.on("closed", () => { mainWindow = null; });
  win.once("ready-to-show", () => win.show());

  // 渲染进程的 console 转发到 stdout。没有这个，渲染层出了问题只能开 devtools 看，
  // 命令行里跑等于瞎子。
  win.webContents.on("console-message", (e) => {
    process.stdout.write(`[renderer] ${e.message}\n`);
  });

  if (smokeEnabled()) {
    process.stdout.write(`[icon] ${icon ?? "未找到"}
`);
    attachSmoke(win, () => app.exit(0));
  }

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  // **必须在建窗口之前调用。** 不设 AppUserModelID，Windows 会按可执行文件把窗口
  // 归到 "Electron" 名下，任务栏继续显示 Electron 的默认图标 —— 即使 BrowserWindow
  // 已经传了 icon。这一行不是可选的润色，是图标能不能生效的前提。
  app.setAppUserModelId("com.agentory.app");

  registerTerminalIpc(() => mainWindow);
  registerThemeIpc(() => mainWindow);
  registerSessionsIpc(() => mainWindow);
  registerWorkspaceIpc(() => mainWindow);
  registerFavoritesIpc();
  registerSummaryIpc(() => mainWindow, summariesEnabled);
  registerAgentsIpc(() => mainWindow, versionCheckEnabled);

  // 主题变化时把原生窗口控件也染上色 —— 变体解析在渲染层，所以由它回传
  ipcMain.on("window:overlay", (_e, c: { color: string; symbolColor: string }) => {
    mainWindow?.setTitleBarOverlay({ ...c, height: TITLEBAR_HEIGHT });
  });

  /**
   * agent 敲了铃。铃由 xterm.js 的 `onBell` 解析出来（它已经在逐字节解析这个流，
   * 能正确区分真铃和 OSC 标题序列末尾那个 BEL —— 自己写正则会大量误报）。
   *
   * **只在窗口失焦时弹系统通知。** 你正看着应用时应用内的小圆点就够了，
   * 再弹一条系统通知纯属噪音。焦点归主进程判断，渲染层不该猜。
   */
  ipcMain.on("notify:bell", (_e, p: { label: string }) => {
    const win = mainWindow;
    if (!win || win.isFocused()) return;
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: "agentory",
      body: `${p.label} 需要你`,
      ...(icon ? { icon } : {}),
    });
    n.on("click", () => {
      if (win.isMinimized()) win.restore();
      win.focus();
    });
    n.show();
  });
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

// 规格要求：应用关闭后不留孤儿进程。
app.on("will-quit", () => {
  killAllSessions();
});
