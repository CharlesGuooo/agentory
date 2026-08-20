import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray } from "electron";
import { registerAgentsIpc } from "./agents/ipc";
import { registerFavoritesIpc } from "./favorites/ipc";
import { registerDiagnosticsIpc } from "./diagnostics";
import { registerHarnessIpc } from "./harness/ipc";
import { registerSessionsIpc } from "./sessions/ipc";
import { registerSummaryIpc } from "./summary/ipc";
import { attachSmoke, smokeEnabled } from "./smoke";
import { killAllSessions, registerTerminalIpc } from "./terminal/ipc";
import { initLang, registerThemeIpc, summariesEnabled, trayHintShown, versionCheckEnabled } from "./theme/service";
import { registerWorkspaceIpc } from "./workspace/ipc";

let mainWindow: BrowserWindow | null = null;

/**
 * 托盘图标。**必须持有引用** —— 丢了就被 GC，图标从任务栏消失。
 */
let tray: Tray | null = null;

/**
 * 用户是不是真的要退出。
 *
 * 分界线在这里：**叉掉窗口 = 收进托盘，从托盘菜单退出 = 真退出。**
 * `before-quit` 先于窗口的 `close` 触发，所以只要在那里置位，
 * `close` 拦截就知道该放行还是该拦。
 */
let quitting = false;

/** 冒烟走优雅退出时要带出去的退出码。见 `attachSmoke` 那段注释。 */
let smokeExitCode: number | null = null;

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

/**
 * 看门狗时长：到点还没画出第一帧就把窗口显示出来（见 `createWindow` 里的注释）。
 * `NOLOAD` 那条验证路径调短 —— 否则每验一次都要干等 15 秒。
 */
const WATCHDOG_MS = process.env["AGENTORY_SMOKE_NOLOAD"] === "1" ? 2000 : 15_000;

/** 把窗口叫回来。托盘左键、托盘菜单、第二个实例都走它。 */
function showWindow(): void {
  const win = mainWindow;
  if (!win) {
    // 理论上不会发生（我们隐藏窗口而不是销毁），但真发生了就重建，
    // 而不是让应用变成一个叫不出来的托盘图标
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * 第一次叉掉窗口时告诉用户它去哪了。
 *
 * **不说的话用户会以为应用崩了** —— 窗口没了、任务栏没了，而它其实还在跑。
 * 只说一次，记在 settings.json 里（和别的设置同一份文件）。
 */
function hintOnce(): void {
  if (trayHintShown.get()) return;
  trayHintShown.set(true);
  if (!Notification.isSupported()) return;
  new Notification({
    title: "Agentory 还在后台",
    body: "会话没有中断。点右下角托盘图标可以打开窗口；要真正退出，右键托盘图标选「退出」。",
    ...(icon ? { icon } : {}),
  }).show();
}

/** 托盘图标。左键开窗口，右键菜单里才有退出。 */
function createTray(): void {
  if (!icon) {
    // 没有图标就没有托盘 —— 少个图标不该让应用起不来，但要说出来：
    // 没有托盘就意味着窗口一藏起来就叫不回来了
    process.stdout.write("[tray] 没有图标，托盘没建 —— 窗口藏起来就叫不回来了\n");
    return;
  }
  tray = new Tray(icon);
  tray.setToolTip("Agentory");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Agentory", click: showWindow },
      { type: "separator" },
      {
        // 这是用户唯一的退出入口，也是**唯一会结束全部会话**的动作，所以要说清楚
        label: "退出（会结束全部会话）",
        // 不用在这里置 `quitting` —— `app.quit()` 会先触发 `before-quit`，那里置
        click: () => app.quit(),
      },
    ]),
  );
  tray.on("click", showWindow);
  if (smokeEnabled()) process.stdout.write("[tray] 托盘已建：左键打开，右键菜单里有退出\n");
}

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

  /**
   * **窗口必须显示出来，哪怕页面没加载成功。**
   *
   * 原来这里只有一行 `win.once("ready-to-show", () => win.show())`，
   * 而加载那句是 `void win.loadFile(...)` —— **失败被整个吞掉**。
   * 加载不成功 → `ready-to-show` 永不触发 → `win.show()` 永不执行 →
   * 窗口永远不显示，**而且一个字都不说**。
   *
   * 这个缺陷是追另一件事时顺手发现的。**那另一件事后来证明是误判**
   *（机器内存压力把 Chromium 的合成拖慢了，不是安装、不是构建，见 D-U11）——
   * 但「加载失败之后一声不吭」本身是真的，和那场误判无关。
   */
  let shown = false;
  let watchdog: NodeJS.Timeout | undefined;
  const reveal = (why: string): void => {
    if (shown) return;
    shown = true;
    if (watchdog) clearTimeout(watchdog);
    process.stdout.write(`[window] ${why}\n`);
    win.show();
  };
  win.once("ready-to-show", () => reveal("画出第一帧，正常显示"));

  /**
   * 加载**确定**失败了 —— 这种要说话。
   *
   * 和下面的看门狗刻意不同：看门狗只知道「慢」，这里知道「坏」。
   * 渲染层已经不可用，所以只剩原生对话框这一条通道。
   * （冒烟里不弹 —— 模态框会把自动化整个挂住。那条路只验日志和「窗口显示了」。）
   */
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    process.stdout.write(`[window] 界面加载失败：${String(code)} ${desc} ${url}\n`);
    reveal("加载失败，先把窗口显示出来");
    if (!smokeEnabled()) {
      dialog.showErrorBox(
        "Agentory 没能加载界面",
        `${desc}（${String(code)}）\n${url}\n\n重开一次通常就好了。`,
      );
    }
  });

  /**
   * 兜底：到点还没画出第一帧就把窗口显示出来，**不弹框**。
   *
   * 这时候我们只知道「慢」，不知道「坏」—— 在一台慢机器上弹「界面没能加载」是误报。
   * 而把窗口显示出来是实打实的改善：用户至少知道应用起来了、能关掉、能用托盘。
   * 本机 `ready-to-show` 实测约 2 秒，15 秒不会误伤。
   */
  watchdog = setTimeout(
    () => reveal(`${String(WATCHDOG_MS)} ms 还没画出第一帧，先把窗口显示出来`),
    WATCHDOG_MS,
  );

  /**
   * **叉掉窗口 = 收进托盘，不是退出。**
   *
   * 这个产品要解决的痛点就是「一直开着的会话」。而在这一步之前，
   * 叉掉窗口走的是 `window-all-closed → app.quit() → will-quit → killAllSessions()`：
   * 实测（`scripts/verify-tray.cjs`）叉窗口之后**应用进程 0 个、agent 进程 0 个** ——
   * 会话连同它们那一堆 MCP 子进程一起没了。
   *
   * **隐藏而不是销毁**：销毁会丢掉全部 xterm 面板与滚动缓冲，再显示时每个 pty
   * 都要重新 attach；而且 `mainWindow` 变 null 会连带打断 `second-instance`
   * 和 `notify:bell` 那两条 `if (!win) return`。
   */
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    hintOnce();
  });

  /**
   * **每次加载都把整页缩放按回 1。**
   *
   * 只把 `Ctrl+-` 改绑掉是不够的 —— **Chromium 把 zoom 持久化在 userData 里**
   * （`Preferences` 的 `partition.per_host_zoom_levels`）。在改绑之前缩过的用户，
   * 升级后仍然卡在那个尺寸，而改绑恰恰把唯一的退路（`Ctrl+=` 放大）也堵死了：
   * **比不修更糟**。用户实测卡在 `-4.5`。
   *
   * `setZoomLevel(0)` 会把 0 写回去，所以这一行同时是自愈的。
   * `setVisualZoomLevelLimits(1, 1)` 关掉触控板捏合缩放 —— 同一类问题的另一个入口。
   *
   * 之所以漏掉：我每次验证都用全新的 `--user-data-dir`，
   * **那恰恰把「持久化」这件事藏了起来**。
   */
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomLevel(0);
    win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  });

  // 渲染进程的 console 转发到 stdout。没有这个，渲染层出了问题只能开 devtools 看，
  // 命令行里跑等于瞎子。
  win.webContents.on("console-message", (e) => {
    process.stdout.write(`[renderer] ${e.message}\n`);
  });

  if (smokeEnabled()) {
    process.stdout.write(`[icon] ${icon ?? "未找到"}
`);
    /**
     * `QUIT=graceful` 走 `app.quit()` —— **用户从托盘退出时走的正是这条路**，
     * 而它在托盘之前一次都没被测过（`app.exit` 跳过 `will-quit`）。
     *
     * ⚠️ **退出码不能靠 `process.exitCode`。** 实测：设了 `process.exitCode = 1`
     * 再 `app.quit()`，进程实际退出码是 **0** —— `app.quit()` 走完关闭流程之后
     * 自己调的是 `exit(0)`，把失败整个吞掉。一个不是绿的绿。
     *
     * 所以把码交给 `will-quit`：等 `killAllSessions()`（正是要测的那件事）跑完，
     * 再用 `app.exit(code)` 把它带出去。
     */
    attachSmoke(win, (code) => {
      if (process.env["AGENTORY_SMOKE_QUIT"] === "graceful") {
        smokeExitCode = code;
        app.quit();
        return;
      }
      app.exit(code);
    });
  }

  /**
   * 两个测试钩子。没有它们，上面那两条兜底路径**只能靠真装一次去撞**，
   * 而它们恰恰是「平时永远不走、真走到时用户最需要」的那种代码。
   *
   * - `NOLOAD`：压根不发起加载 → 只有看门狗能救场
   * - `BADLOAD`：加载一个不存在的文件 → 走 `did-fail-load`
   */
  const load = (): Promise<void> => {
    if (process.env["AGENTORY_SMOKE_NOLOAD"] === "1") {
      process.stdout.write("[window] NOLOAD：故意不发起加载，看看看门狗救不救得回来\n");
      return Promise.resolve();
    }
    if (process.env["AGENTORY_SMOKE_BADLOAD"] === "1") {
      return win.loadFile(join(import.meta.dirname, "../renderer/这个文件不存在.html"));
    }
    if (process.env["ELECTRON_RENDERER_URL"]) {
      return win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    }
    return win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  };
  // 具体的错误由上面的 `did-fail-load` 报。这里只是别让它变成 unhandled rejection ——
  // 原来那个 `void` 连这一层都没有，失败之后整个应用一声不吭。
  load().catch(() => undefined);
}

/**
 * **一个用户只跑一个实例。**
 *
 * 没有这一行，双击两次图标就是两个进程共写 `workspace.json` / `favorites.json` /
 * `summaries.json` —— 每个都拿着自己启动时读到的那份做「读-改-写」，
 * 后写的把先写的整个盖掉。A 加了 3 条、B 加 1 条，A 那 3 条就没了。
 * 摘要缓存尤其贵：那是**花过钱**的东西。
 *
 * 锁按 `userData` 路径分，所以 `verify:clean` / `verify:broken` 那些假家目录的运行
 * 各有各的锁，不会被真实例挡住。
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  process.stdout.write("[single-instance] 已经有一个 agentory 在跑，这个实例退出\n");
  /**
   * 冒烟模式下退 1 而不是 0。**残留的实例会让冒烟秒退并报「全部通过」** ——
   * 一个什么都没跑过的假绿，比红色危险得多（今天就清理过两次残留 electron）。
   */
  app.exit(smokeEnabled() ? 1 : 0);
}

/**
 * 第二次双击图标 = 「把那个窗口给我叫出来」，不是「再开一个」。
 *
 * **托盘常驻之后这条路径变成了关键路径**：窗口被隐藏时锁还被后台进程持有，
 * 新实例会立刻退出，所以叫回窗口的责任全在这里。
 * 原来是 `if (!win) return;` —— 那会让应用变成一个叫不出来的僵尸。
 */
app.on("second-instance", showWindow);

// 从托盘退出，或系统关机 —— `before-quit` 先于窗口的 `close` 触发，
// 所以在这里置位，`close` 拦截就知道该放行
app.on("before-quit", () => {
  quitting = true;
});

void app.whenReady().then(() => {
  if (!gotLock) return;
  // **必须在建窗口之前调用。** 不设 AppUserModelID，Windows 会按可执行文件把窗口
  // 归到 "Electron" 名下，任务栏继续显示 Electron 的默认图标 —— 即使 BrowserWindow
  // 已经传了 icon。这一行不是可选的润色，是图标能不能生效的前提。
  app.setAppUserModelId("com.agentory.app");

  /**
   * **语言要第一个定下来。** 下面每个 registerXxxIpc 都会在注册时读一次记录文件，
   * 而那些校验失败的告警是直接显示给用户的 —— 晚一步定语言，
   * 启动告警就会一半英文一半中文（见 `initLang` 的注释）。
   */
  initLang();

  registerTerminalIpc(() => mainWindow);
  registerThemeIpc(() => mainWindow);
  registerSessionsIpc(() => mainWindow);
  registerWorkspaceIpc(() => mainWindow);
  registerFavoritesIpc();
  registerSummaryIpc(() => mainWindow, summariesEnabled);
  registerAgentsIpc(() => mainWindow, versionCheckEnabled);
  registerHarnessIpc();
  registerDiagnosticsIpc();

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
    n.on("click", showWindow);
    n.show();
  });
  createTray();
  createWindow();
});

/**
 * **托盘常驻之后这个事件基本不会触发** —— 窗口是被隐藏的，不是被销毁的。
 *
 * 会走到这里只剩一种情况：窗口意外没了（渲染进程崩了之类）。那时该不该继续跑，
 * **判据是有没有托盘**：有托盘，用户点一下就能把窗口叫回来（`showWindow` 会重建），
 * 会话也还活着，值得留；没托盘（`createTray` 因为没图标早退过），
 * 那就是一个**再也叫不出来的进程**，留着只会让人以为应用还好好的。
 */
app.on("window-all-closed", () => {
  if (!tray) app.quit();
});

/**
 * 规格要求：应用关闭后不留孤儿进程。
 *
 * ⚠️ **这条路径在托盘之前从来没被测过**：冒烟的 quit 回调是 `app.exit()`，
 * 而 `app.exit` 按 Electron 文档明确「不触发 before-quit 和 will-quit」——
 * 也就是 `killAllSessions()` 一次都没跑过，`verify:orphans` 之所以绿，
 * 靠的是主进程死亡本身销毁了 ConPTY 句柄。
 *
 * 现在「从托盘退出」是用户**唯一**的退出方式，走的正是这条路。
 * 所以冒烟加了 `QUIT=graceful`，`verify:orphans` 两条路各跑一遍。
 */
app.on("will-quit", () => {
  killAllSessions();
  // 冒烟的优雅退出：`killAllSessions()` 已经跑完，现在把退出码带出去。
  // `setImmediate` 是为了让这一轮事件循环收尾（pty 的清理有异步的一半）。
  if (smokeExitCode !== null) {
    const code = smokeExitCode;
    setImmediate(() => app.exit(code));
  }
});
