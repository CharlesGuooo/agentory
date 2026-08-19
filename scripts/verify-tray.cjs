/**
 * 托盘常驻：叉掉窗口之后，应用和会话都得还在。
 *
 * ## 为什么只能从外面看
 *
 * 要验的是「窗口没了，进程还在吗」。窗口没了之后渲染层就没法执行脚本了，
 * 而如果应用也一起死了，它连一行输出都留不下 —— 所以判断必须由一个
 * 在外面拿着进程快照等待的脚本来做。
 *
 * 冒烟侧只负责制造状态：`AGENTORY_SMOKE_CLOSE=1` 走完检查后 `win.close()`，
 * **不调 quit**（调了就分不清是谁退的）。
 *
 * ## 它验四件事
 *
 * 1. 起一个真会话
 * 2. 叉掉窗口 → **应用进程还活着**（托盘常驻）
 * 3. 叉掉窗口 → **agent 进程还活着**（这才是用户的痛点：一直开着的会话）
 * 4. 然后真退出 → 进程树归零（走 `app.quit()` 那条路，见 verify:orphans）
 *
 * 用法：`npm run verify:tray`
 */

const { execFileSync, spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { procs, isAgent, isElectron } = require("./proc-snapshot.cjs");
/**
 * **必须是异步的 sleep。**
 *
 * 第一版用 `execFileSync("Start-Sleep")` —— 它把 Node 的事件循环整个卡住，
 * 子进程的 `data` 事件在等待期间一次都不触发，于是「会话真的起来了」这类
 * 靠输出判断的前提检查全部误判为失败（而那些输出其实产生了）。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => {
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { stdio: "ignore" });
  } catch {
    /* 已经没了 */
  }
};

const beforeIds = new Set(procs().map((p) => p.ProcessId));

let failed = false;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "❌"} ${msg}`);
  if (!ok) failed = true;
};

/**
 * **自己的 userData。** 单实例锁按 userData 路径分，而用户自己那份 Agentory
 * 很可能正开着。不隔离的话这个脚本会被锁挡掉、什么都没跑，
 * 然后「agent 进程 0 个」看起来像成功复现了 bug —— **假的复现比假绿更糟**。
 * 实测撞到过一次。
 */
const ud = mkdtempSync(join(tmpdir(), "agentory-tray-ud-"));

console.log("起一个会话，然后叉掉窗口……\n");

let out = "";
const child = spawn("npx", ["electron", ".", `--user-data-dir=${ud}`], {
  env: {
    ...process.env,
    AGENTORY_SMOKE: "1",
    AGENTORY_SMOKE_NEW: "1",
    AGENTORY_SMOKE_CLOSE: "1",
    AGENTORY_SMOKE_DELAY: "2000",
  },
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});
for (const s of [child.stdout, child.stderr]) {
  s.setEncoding("utf8");
  s.on("data", (d) => {
    out += d;
    process.stdout.write(d);
  });
}

void (async () => {
  // 叉窗口发生在冒烟走完之后；等到那一行出现，或者超时
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !out.includes("[smoke-close]") && !out.includes("[single-instance]")) {
    await sleep(1000);
  }
  await sleep(4000); // 叉完之后给它几秒钟去死（或者活着）

  console.log("\n[tray] 前提检查（这几条不成立的话，下面的结论一律无效）：");
  check(!out.includes("[single-instance]"), "没有被单实例锁挡掉");
  check(out.includes("已点击开始"), "会话真的起来了");
  check(out.includes("[smoke-close]"), "真的走到了叉窗口那一步");

  const myElectron = procs().filter((p) => isElectron(p) && !beforeIds.has(p.ProcessId));
  const mine = procs().filter((p) => isAgent(p) && !beforeIds.has(p.ProcessId));

  console.log("\n[tray] 叉掉窗口之后：");
  check(myElectron.length > 0, `应用进程还活着：${myElectron.length} 个（托盘常驻）`);
  check(mine.length > 0, `agent 进程还在跑：${mine.length} 个 ${mine.map((p) => p.Name).join(",")}`);

  /**
   * 收尾。**这里不再断言「零残留」** —— 那条断言原来是错的。
   *
   * `kill()` 走的是 `Stop-Process -Force`，也就是 `TerminateProcess`：
   * 被强杀的进程**没有任何机会跑代码**，`before-quit` / `will-quit` 都不会触发，
   * 于是 `killAllSessions()` 根本没执行。断言它执行过，是在要求操作系统做不到的事。
   * （表现为间歇性红：pty 主端关闭时子进程**多半**会跟着退，但那是竞态不是保证。）
   *
   * 它本来想验的那件事由 `verify-orphans.cjs` 覆盖，而且是**两条真实退出路径各一遍**
   * （窗口全关、`app.quit()`）—— 那两条才会走 `will-quit`。
   *
   * **真正没被覆盖的**是「用户从任务管理器强杀 Agentory」。那种情况下会留下 agent 进程，
   * 要兜住得把子进程放进 Job Object 并设 `KILL_ON_JOB_CLOSE`，让内核代劳。
   * 记在这里，没做。
   */
  console.log("\n[tray] 收尾：强杀应用，并把它起的 agent 一起收干净……");
  for (const p of myElectron) kill(p.ProcessId);
  kill(child.pid);
  await sleep(6000);
  const left = procs().filter((p) => isAgent(p) && !beforeIds.has(p.ProcessId));
  for (const p of left) kill(p.ProcessId);
  console.log(`  强杀之后要自己收的 agent 进程：${left.length} 个（不算失败，见上面的注释）`);
  try {
    rmSync(ud, { recursive: true, force: true });
  } catch {
    /* 占着就留着，重启后会没 */
  }

  console.log(failed ? "\n结论：有失败项" : "\n结论：全部通过");
  process.exitCode = failed ? 1 : 0;
})();
