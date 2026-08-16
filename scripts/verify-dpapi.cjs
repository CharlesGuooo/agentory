/**
 * DPAPI 往返：**加密 → 落盘 → 换一个进程 → 解密**。
 *
 * 跑两次应用，**共用同一个假 APPDATA** —— 第二次是全新进程，
 * 它要能把第一次写下的密文解开。这就是 `safeStorage` 在真实使用中要做的事：
 * 用户今天填 key，明天开应用还得能用。
 *
 * ## 它顺带覆盖的洞
 *
 * 假 APPDATA 是空的，所以 `userData` 目录一开始**不存在** ——
 * `summary/ipc.ts` 曾经在这里少一个 `mkdirSync`，后果是新机器上 key 静默丢失。
 *
 * ## 它不能替代什么
 *
 * 换一个 Windows 账户验的是「DPAPI 用了另一把用户密钥」。
 * 机制本身这里就能验，但「全新 Windows 配置文件」只有真账户能给。
 *
 * 用法：`npm run verify:dpapi`
 */

const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const home = mkdtempSync(join(tmpdir(), "agentory-dpapi-home-"));
const appdata = mkdtempSync(join(tmpdir(), "agentory-dpapi-appdata-"));
// Chromium 要求这三个目录存在，否则改了 USERPROFILE 之后 Electron 直接异常退出
for (const d of ["Local", "Roaming", "LocalLow"]) {
  mkdirSync(join(home, "AppData", d), { recursive: true });
}

const base = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  APPDATA: appdata,
  LOCALAPPDATA: join(appdata, "Local"),
  AGENTORY_SMOKE: "1",
  AGENTORY_SMOKE_DELAY: "800",
};

/**
 * **不要猜密文文件在哪。** 第一版写死了 `<appdata>/agentory/deepseek.key`，
 * 结果报「文件根本没出现」，而应用其实读得好好的 ——
 * 实测真实位置是 **`<假家目录>/AppData/Roaming/agentory/deepseek.key`** ——
 * 同时设了 `USERPROFILE` 和 `APPDATA` 时，**Electron 的 appData 是从 `USERPROFILE` 推的**，
 * `APPDATA` 变量不起作用（只设 APPDATA 的那次探测看不出这一点）。
 *
 * 猜错路径的断言比没有断言更糟：它两次让我以为功能坏了，而功能一直是好的。
 * 所以这里两个根都搜。
 */
function findKeyFile(dir, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === "deepseek.key") return p;
    if (e.isDirectory()) {
      const hit = findKeyFile(p, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function launch(phase) {
  console.log(`\n—— 第 ${phase === "set" ? "1" : "2"} 次启动（${phase}）——`);
  try {
    execFileSync("npx", ["electron-vite", "preview"], {
      env: { ...base, AGENTORY_SMOKE_DPAPI: phase },
      stdio: "inherit",
      shell: true,
      timeout: 120_000,
    });
  } catch (e) {
    // **退出码现在有意义了** —— 冒烟里的 `check()` 失败会让应用 exit(1)。
    // 原来这里写着「退出码不重要」，那是在断言存在之前。
    console.log(`（第 ${phase} 次退出码 ${e.status ?? "?"}）`);
    process.exitCode = 1;
  }
}

try {
  launch("set");
  const keyFile = findKeyFile(home) ?? findKeyFile(appdata);
  console.log(
    keyFile
      ? `\n[dpapi-file] 密文写下了：${statSync(keyFile).size} 字节  ${keyFile}`
      : "\n[dpapi-file] ❌ 整个假 APPDATA 里都没有 deepseek.key",
  );
  if (keyFile) {
    // 密文里不该出现明文 —— 这是「加密真的发生了」的直接证据
    const raw = readFileSync(keyFile);
    console.log(
      `[dpapi-file] 密文里含明文：${raw.includes(Buffer.from("sk-dpapi-roundtrip")) ? "❌ 是" : "否 ✓"}`,
    );
  }

  launch("check");
} finally {
  // **清理失败不能致命** —— Windows 上 Electron 刚退出时临时目录常被占住（EPERM），
  // 而 finally 里抛出的异常会**盖掉 try 里真正的错误**，让人以为问题出在清理上。
  for (const d of [home, appdata]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch (e) {
      console.log(`（临时目录没删掉，不影响结论：${d}）`);
    }
  }
}
