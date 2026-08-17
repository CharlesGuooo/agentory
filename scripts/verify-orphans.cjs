/**
 * 应用退出之后，全系统一个 agent 进程都不该剩。**两条退出路径各跑一遍。**
 *
 * ## 为什么必须是外层脚本
 *
 * 冒烟里的 `smokeEnd` 验的是「点 ✕ 之后那一棵树消失」，而且注释写明**检查要在应用
 * 还活着时做** —— 否则 `will-quit` 的兜底清理会把漏杀的也一起收走，那就永远测不出
 * 「结束会话」自己漏没漏。反过来那一半只能在应用死之后看，所以只能是外层脚本。
 *
 * ## 两条路，而且它们测的不是同一件事
 *
 * | | 走什么 | 真正在验什么 |
 * |---|---|---|
 * | `hard` | `app.exit()` | **`will-quit` 不触发**（Electron 文档明写），所以
 *   `killAllSessions()` 根本没跑 —— 验的是「主进程死亡本身销毁 ConPTY 句柄」这条兜底 |
 * | `graceful` | `app.quit()` | 触发 `will-quit` → `killAllSessions()`。
 *   **用户从托盘退出时走的正是这条**，而它在托盘落地之前一次都没被测过 |
 *
 * > 这个文件原来的头注释写着它验的是 `killAllSessions`。**那句话与实际代码路径不符** ——
 * > 冒烟一直走 `app.exit`，那个函数一次都没被执行过。
 *
 * 用法：`npm run verify:orphans`
 */

const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { procs, isAgent } = require("./proc-snapshot.cjs");

let failed = false;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "❌"} ${msg}`);
  if (!ok) failed = true;
};

function round(kind) {
  console.log(`\n===== ${kind} =====`);
  const beforeIds = new Set(procs().map((p) => p.ProcessId));

  /**
   * **自己的 userData。** 单实例锁按它分，而用户自己那份很可能正开着。
   * 不隔离的话这一轮会被锁挡掉、什么都没跑，然后「残留 0 个」看起来像通过 ——
   * 一个什么都没验的假绿。实测在 `verify-tray.cjs` 上撞到过。
   */
  const ud = mkdtempSync(join(tmpdir(), `agentory-orph-${kind}-`));
  let out = "";
  try {
    out = execFileSync("npx", ["electron", ".", `--user-data-dir=${ud}`], {
      env: {
        ...process.env,
        AGENTORY_SMOKE: "1",
        AGENTORY_SMOKE_NEW: "all",
        AGENTORY_SMOKE_ALL_WAIT: "10000",
        AGENTORY_SMOKE_DELAY: "3000",
        ...(kind === "graceful" ? { AGENTORY_SMOKE_QUIT: "graceful" } : {}),
      },
      encoding: "utf8",
      shell: true,
      timeout: 300_000,
    });
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
    console.log(`（退出码 ${e.status ?? "?"}）`);
    failed = true;
  }
  process.stdout.write(out);

  // 前提：这一轮真的跑过东西。不查的话，被锁挡掉也会「通过」
  check(!out.includes("[single-instance]"), "没有被单实例锁挡掉");
  check(out.includes("[smoke-all-tabs]"), "五个 agent 真的起来了");

  execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 5"], { stdio: "ignore" });
  const leaked = procs().filter((p) => isAgent(p) && !beforeIds.has(p.ProcessId));
  check(leaked.length === 0, `退出后新增的 agent 进程：${leaked.length}`);
  for (const p of leaked) console.log(`     ${p.ProcessId}  ${p.Name}`);

  try {
    rmSync(ud, { recursive: true, force: true });
  } catch {
    /* 占着就留着 */
  }
}

round("hard");      // app.exit —— will-quit 不触发
round("graceful");  // app.quit —— 托盘退出走的这条

console.log(failed ? "\n结论：有失败项" : "\n结论：两条退出路径都干净");
process.exitCode = failed ? 1 : 0;
