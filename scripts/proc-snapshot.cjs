/**
 * 全系统进程快照。`verify-tray.cjs` 与 `verify-orphans.cjs` 共用。
 *
 * 抽出来是因为两边**逐字相同** —— 而不是因为「复用」这个词本身。
 * （`smoke.ts` 里还有第三份，那是 TS 且跑在 Electron 主进程里，共用不了；
 * 那一份的存在理由见它自己的注释。）
 *
 * 只认这几个名字：`node.exe` 不算 —— 开发机上到处都是别人的 node，
 * 把它算进来的话「残留 0 个」这条断言永远不可能成立。
 */

const { execFileSync } = require("node:child_process");

const AGENT_NAMES = [/^claude/i, /^codex/i, /^opencode/i, /^pi\.exe$/i, /^grok/i];

function procs() {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

const isAgent = (p) => AGENT_NAMES.some((re) => re.test(p.Name));
const isElectron = (p) => /^(electron|agentory)\.exe$/i.test(p.Name);

module.exports = { procs, isAgent, isElectron };
