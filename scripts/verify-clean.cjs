/**
 * 把真应用跑成「一台没有任何 agent 的新机器上的新用户」。
 *
 * ## 为什么不需要第二台机器、也不需要第二个 Windows 账户
 *
 * 三条已实测的事实：
 *
 * | | |
 * |---|---|
 * | `os.homedir()` 认 `USERPROFILE` | 我们所有 agent 路径解析（`src/main/paths.ts`）跟着走 |
 * | Electron 的 `app.getPath("userData")` 跟着 `APPDATA` | 全新的应用数据目录，没有任何配置与缓存 |
 * | `where.exe` 认改过的 `PATH` | `resolveCommand` 全部抛错 = 一个 agent 都没装 |
 *
 * ⚠️ **PATH 不能剥到只剩 System32** —— 启动器自己要用 node。
 * 所以剥的是「agent 所在的那些目录」，留下 node。这反而更贴近真实：
 * 一台装了 Node 但没装任何 agent 的机器，正是新用户最常见的样子。
 *
 * 用法：`npm run verify:clean`（加 `--shots` 顺便截图）
 */

const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

/** 从 PATH 里去掉所有可能装着 agent 的目录，留下 node 和系统目录。 */
function stripAgents(path) {
  const AGENT_HOMES = [/\\npm$/i, /\\\.grok\\/i, /\\\.local\\bin$/i, /\\\.bun\\bin$/i, /\\yarn\\/i, /\\pnpm/i];
  return path
    .split(";")
    .filter((p) => p.trim() !== "")
    .filter((p) => !AGENT_HOMES.some((re) => re.test(p)))
    .join(";");
}

const shots = process.argv.includes("--shots");
const home = mkdtempSync(join(tmpdir(), "agentory-clean-home-"));
const appdata = mkdtempSync(join(tmpdir(), "agentory-clean-appdata-"));

/**
 * **Chromium 要求 `%USERPROFILE%\AppData` 那三个目录存在**，否则 Electron 直接异常退出
 * （实测：只改 `USERPROFILE` 不建这三个目录，退出码 0x80000003，一行输出都没有）。
 * 真实的新用户机器上它们本来就在，所以这不是在掩盖问题，是在把假家目录造得像真的。
 */
for (const d of ["Local", "Roaming", "LocalLow"]) {
  mkdirSync(join(home, "AppData", d), { recursive: true });
}
const shotDir = shots ? mkdtempSync(join(tmpdir(), "agentory-clean-shots-")) : null;

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  APPDATA: appdata,
  LOCALAPPDATA: join(appdata, "Local"),
  PATH: stripAgents(process.env.PATH ?? ""),
  // agent 自己的覆盖变量也要清掉，否则会指回真配置
  CLAUDE_CONFIG_DIR: "",
  CODEX_HOME: "",
  OPENCODE_CONFIG_DIR: "",
  XDG_CONFIG_HOME: "",
  XDG_DATA_HOME: "",
  GROK_HOME: "",
  AGENTORY_SMOKE: "1",
  AGENTORY_SMOKE_DELAY: "1000",
  AGENTORY_SMOKE_CLEAN: "1",
  ...(shotDir ? { AGENTORY_SMOKE_CLEAN_SHOTS: shotDir } : {}),
};

console.log("空机器：");
console.log("  家目录   " + home);
console.log("  APPDATA " + appdata);
if (shotDir) console.log("  截图     " + shotDir);
console.log("  PATH 里还剩 " + env.PATH.split(";").length + " 项（原本 " + (process.env.PATH ?? "").split(";").length + " 项）");
console.log("");

try {
  // **stdio 直接继承** —— 实测捕获缓冲区里是空的，electron 的输出进不去。
  // 让它直接打到这里，调用方自己 grep `[clean`。
  execFileSync("npx", ["electron-vite", "preview"], {
    env,
    stdio: "inherit",
    shell: true,
    timeout: 180_000,
  });
} catch (e) {
  // **退出码现在有意义了。** 冒烟里的 `check()` 失败会让应用 exit(1)，
  // 而 preview 会把它带上来。以前这里写着「退出码非 0 不影响我们要看的东西」，
  // 那是在断言存在之前 —— 现在把它咽掉就等于把红色咽掉。
  console.log("\n（preview 退出码 " + (e.status ?? "?") + "）");
  process.exitCode = 1;
} finally {
  // **清理失败不等于验证失败。** 假家目录偶尔会被残留进程占着，`rmSync` 抛 EPERM，
  // 而它在 finally 里 —— 于是一次全部通过的验证被报成失败（实测撞到了）。
  // 临时目录留在那儿最多占点盘，掩盖结果才是真问题。
  for (const dir of [home, appdata]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.log("（清理不掉 " + dir + "：" + err.code + "，重启后会没）");
    }
  }
  if (shotDir) console.log("\n截图留在 " + shotDir);
}
