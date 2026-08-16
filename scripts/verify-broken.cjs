/**
 * 「坏机器」profile —— 和空机器并列的第三个环境。
 *
 * ## 它和 verify:clean 的分工
 *
 * | | 造的是什么 | 验的是什么 |
 * |---|---|---|
 * | `verify:clean` | 什么都没有 | 空态文案说的是不是真话 |
 * | `verify:broken` | **应用自己的记录全坏了 + 有一条指向已删目录的会话** | 坏数据下界面说不说真话、会不会静默销毁 |
 *
 * 造法与空机器同源（三个环境变量），但 **PATH 保持原样** ——
 * 这台机器是装了 agent 的，坏的是我们自己的数据。
 *
 * ## 它专门盯的两件事
 *
 * 1. **点一个目录已消失的成员** → 侧栏必须说出原因。
 *    在加 `#sideNote` 之前，那条路径**没有任何报错出口**：主进程如实带回了
 *    `{ok:false, error}`，而 `activate()` 把整个返回值 `void` 掉了 ——
 *    用户看到的是「点一下，什么都没发生」。
 *    （注意 `activate` 不查 `missingCwd`，只有恢复横幅查 —— 所以这一击真的会打到启动。）
 * 2. **坏文件不能被下一次正常写入抹掉** —— `<文件>.bak` 必须出现。
 *
 * 用法：`npm run verify:broken`
 */

const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const home = mkdtempSync(join(tmpdir(), "agentory-broken-home-"));
for (const d of ["Local", "Roaming", "LocalLow"]) {
  mkdirSync(join(home, "AppData", d), { recursive: true });
}

/**
 * userData 的位置：同时设 USERPROFILE 和 APPDATA 时，**Electron 从 USERPROFILE 推**
 * （verify-dpapi 那次实测的结论，猜错过两次）。所以这里只认这一个根。
 */
const userData = join(home, "AppData", "Roaming", "agentory");
mkdirSync(userData, { recursive: true });

/** 一个绝对不存在的目录 —— 用来模拟「会话的工作目录被删了」。 */
const goneDir = join(home, "已经被删掉的项目目录");

const seed = {
  // 一条指向已删目录的（合法但起不来，供点击用）+ 一条读不动的（供备份断言用）
  "workspace.json": JSON.stringify(
    {
      version: 1,
      sessions: [
        { agent: "claude", sessionId: null, cwd: goneDir, addedAt: "2026-08-01T00:00:00.000Z" },
        { 这条: "读不动", 没有: "agent" },
      ],
    },
    null,
    2,
  ),
  // 3 条里坏 1 条 —— 验「坏条目不会在下次正常写入时被抹掉」
  "favorites.json": JSON.stringify(
    {
      version: 1,
      sessions: [
        { agent: "claude", sessionId: "aaaa", cwd: home, addedAt: "2026-08-01T00:00:00.000Z" },
        { 这条: "缺字段", 没有: "agent" },
      ],
    },
    null,
    2,
  ),
  "settings.json": "{ 这不是 JSON",
  "summaries.json": "{{{ 也不是",
};
for (const [name, body] of Object.entries(seed)) writeFileSync(join(userData, name), body);
mkdirSync(join(userData, "themes"), { recursive: true });
writeFileSync(join(userData, "themes", "坏主题.json"), "{ 不是 JSON");

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  // PATH 原样 —— 这台机器是装了 agent 的
  AGENTORY_SMOKE: "1",
  AGENTORY_SMOKE_DELAY: "1500",
  AGENTORY_SMOKE_START_MEMBER: "1",
  AGENTORY_SMOKE_START_WAIT: "12000",
  AGENTORY_SMOKE_BROKEN: "1",
};

console.log("坏机器：");
console.log("  家目录     " + home);
console.log("  userData  " + userData);
console.log("  已删目录   " + goneDir + "（存在？" + existsSync(goneDir) + "）");
console.log("");

let failed = false;
try {
  execFileSync("npx", ["electron-vite", "preview"], {
    env,
    stdio: "inherit",
    shell: true,
    timeout: 180_000,
  });
} catch (e) {
  console.log("\n（preview 退出码 " + (e.status ?? "?") + "）");
  failed = true;
}

// ---- 落盘侧的断言：坏文件必须还在别处留着 ----
console.log("\n[broken-backups]");
for (const name of ["workspace.json", "favorites.json"]) {
  const bak = join(userData, name + ".bak");
  const ok = existsSync(bak);
  console.log(`  ${name}.bak  ${ok ? "在 ✓" : "❌ 没有 —— 坏记录被静默销毁了"}`);
  if (!ok) failed = true;
}
const favBak = join(userData, "favorites.json.bak");
if (existsSync(favBak)) {
  const raw = JSON.parse(readFileSync(favBak, "utf8"));
  const kept = raw.sessions.some((s) => s["这条"] === "缺字段");
  console.log(`  备份里那条坏记录  ${kept ? "原样保着 ✓" : "❌ 不见了"}`);
  if (!kept) failed = true;
}

// 清理失败不等于验证失败（verify-clean 那边踩过：finally 里的 EPERM 盖掉了成功）
try {
  rmSync(home, { recursive: true, force: true });
} catch (err) {
  console.log("（清理不掉 " + home + "：" + err.code + "，重启后会没）");
}

console.log(failed ? "\n结论：有失败项" : "\n结论：全部通过");
process.exitCode = failed ? 1 : 0;
