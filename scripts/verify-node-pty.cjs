// 验证：node-pty 的预编译产物能否在 Electron 里直接用，不做 ABI 重建。
//
// 背景：electron-rebuild 在本机失败（node-pty 的 binding.gyp 仍依赖 winpty，
// 其 GetCommitHash.bat 调用挂掉）。但 node-pty 依赖 node-addon-api（N-API），
// N-API 的 ABI 对 Node 和 Electron 是通用的，且它的加载器会回退到 prebuilds/。
// 如果这个假设成立，那一整步重建都不需要。
//
// 跑法： npx electron scripts/verify-node-pty.cjs

const { app } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const out = [];
const log = (s) => { out.push(s); console.log(s); };

app.whenReady().then(async () => {
  let ok = false;
  try {
    const pty = require("node-pty");
    log(`electron   : ${process.versions.electron}`);
    log(`node       : ${process.versions.node}`);
    log(`modules ABI: ${process.versions.modules}`);
    log(`node-pty   : 加载成功`);

    // 加载器实际用了哪个目录（build/Release 还是 prebuilds/）
    const utils = require("node-pty/lib/utils.js");
    const loaded = utils.loadNativeModule("conpty");
    log(`原生模块来源: ${loaded.dir}`);

    const chunks = [];
    const p = pty.spawn("cmd.exe", ["/c", "echo node-pty-alive"], { cols: 80, rows: 24 });
    p.onData((c) => chunks.push(c));

    const code = await new Promise((res) => {
      p.onExit(({ exitCode }) => res(exitCode));
      setTimeout(() => res(-1), 8000);
    });

    const text = chunks.join("");
    ok = code === 0 && text.includes("node-pty-alive");
    log(`spawn 退出码 : ${code}`);
    log(`输出含标记   : ${text.includes("node-pty-alive")}`);
    log(ok ? "结论: 无需 ABI 重建，预编译产物在 Electron 下可用" : "结论: 失败");
  } catch (e) {
    log(`失败: ${e.message}`);
  }

  writeFileSync(join(__dirname, "verify-node-pty.out.txt"), out.join("\n") + "\n");
  app.exit(ok ? 0 : 1);
});
