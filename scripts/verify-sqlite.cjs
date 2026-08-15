// 任务 1.1：验证 Electron 里能否用 Node 内置的 node:sqlite 只读打开 OpenCode 的库。
//
// 通过 → OpenCode 扫描器零依赖，完全避开原生模块编译（我们已经在 node-pty 上踩过那个坑）。
// 不通过 → 退 better-sqlite3。**不要**退回去调 sqlite3.exe 子进程，
//          那会把一个外部可执行文件变成运行时依赖。
//
// 跑法： npx electron scripts/verify-sqlite.cjs

const { app } = require("electron");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { statSync } = require("node:fs");

const DB = join(homedir(), ".local", "share", "opencode", "opencode.db");

app.whenReady().then(() => {
  let ok = false;
  try {
    console.log(`electron  : ${process.versions.electron}`);
    console.log(`node      : ${process.versions.node}`);
    console.log(`库大小     : ${(statSync(DB).size / 1024 / 1024).toFixed(1)} MB`);

    const { DatabaseSync } = require("node:sqlite");
    console.log(`node:sqlite: 可加载`);

    // 只读打开。库正被 opencode 使用且有 WAL —— 这是真实场景，不是理想条件。
    const db = new DatabaseSync(DB, { readOnly: true });

    const n = db.prepare("SELECT COUNT(*) AS n FROM session").get();
    const sample = db
      .prepare(
        "SELECT id, directory, title, time_updated FROM session ORDER BY time_updated DESC LIMIT 3",
      )
      .all();

    console.log(`会话数     : ${n.n}`);
    console.log(`取样       :`);
    for (const s of sample) {
      console.log(`  ${String(s.title).slice(0, 34).padEnd(36)} ${s.directory}`);
    }

    // 只读是否真的只读 —— 写入必须失败
    let writeBlocked = false;
    try {
      db.prepare("CREATE TABLE agentory_probe (x INTEGER)").run();
    } catch {
      writeBlocked = true;
    }
    console.log(`写入被拒   : ${writeBlocked}`);

    db.close();
    ok = n.n > 0 && writeBlocked;
    console.log(ok ? "结论: 可用，OpenCode 扫描器零依赖" : "结论: 不满足要求");
  } catch (e) {
    console.log(`失败: ${e.message}`);
  }
  app.exit(ok ? 0 : 1);
});
