/**
 * 应用退出之后，全系统一个 agent 进程都不该剩。
 *
 * ## 为什么必须是外层脚本
 *
 * 冒烟里的 `smokeEnd` 验的是「点 ✕ 之后那一棵树消失」，而且注释写明**检查要在应用
 * 还活着时做** —— 否则 `will-quit` 的兜底清理会把漏杀的也一起收走，那就永远测不出
 * 「结束会话」自己漏没漏。
 *
 * 但反过来那一半也得有人验：`killAllSessions` 到底有没有把剩下的全带走？
 * 那件事只能在**应用死之后**看，所以只能是外层脚本。
 *
 * 这一击起五个 agent（每个都会再拉起一堆 MCP 子进程），然后让应用正常退出。
 *
 * 用法：`npm run verify:orphans`
 */

const { execFileSync } = require("node:child_process");

/** 只盯这些名字。`node.exe` 不算 —— 这台机器上到处都是别人的 node。 */
const AGENT_NAMES = [/^claude/i, /^codex/i, /^opencode/i, /^pi\.exe$/i, /^grok/i];

function procs() {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

const isAgent = (p) => AGENT_NAMES.some((re) => re.test(p.Name));

const before = procs();
const beforeIds = new Set(before.map((p) => p.ProcessId));
const beforeAgents = before.filter(isAgent);
console.log(`启动前：全系统 ${before.length} 个进程，其中 agent 名字的 ${beforeAgents.length} 个`);

let failed = false;
try {
  execFileSync("npx", ["electron-vite", "preview"], {
    env: {
      ...process.env,
      AGENTORY_SMOKE: "1",
      AGENTORY_SMOKE_NEW: "all",
      AGENTORY_SMOKE_ALL_WAIT: "10000",
      AGENTORY_SMOKE_DELAY: "3000",
    },
    stdio: "inherit",
    shell: true,
    timeout: 300_000,
  });
} catch (e) {
  console.log(`\n（preview 退出码 ${e.status ?? "?"}）`);
  failed = true;
}

// electron 退出后系统要一小会儿才把子进程收干净
execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 5"], { stdio: "ignore" });

const after = procs();
const leaked = after.filter((p) => isAgent(p) && !beforeIds.has(p.ProcessId));

console.log("\n[orphans]");
if (leaked.length === 0) {
  console.log("  退出后新增的 agent 进程：0 ✓");
} else {
  failed = true;
  console.log(`  ❌ 退出后还剩 ${leaked.length} 个 agent 进程：`);
  for (const p of leaked) console.log(`     ${p.ProcessId}  ${p.Name}`);
}

console.log(failed ? "\n结论：有失败项" : "\n结论：全部通过");
process.exitCode = failed ? 1 : 0;
