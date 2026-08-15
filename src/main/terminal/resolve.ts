import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, normalize } from "node:path";

export interface ResolvedCommand {
  exe: string;
  args: string[];
  /** 怎么解析出来的，出问题时用来定位 */
  via: string;
}

/**
 * 把命令名解析成真正的可执行文件。
 *
 * 为什么必须有这一步：Windows 的 CreateProcess 跑不了 `.cmd`，而 claude / codex /
 * opencode / pi 在 PATH 里都只是 npm 生成的 `.cmd` shim。套一层 `cmd.exe` 能跑，
 * 但那是在 PTY 和 agent 之间多插一个进程 —— 会多一层信号转发、多一个要清理的孤儿。
 *
 * 逻辑来自 probes/resolve-agent.mjs，那份在五个 agent 上全部验证通过。
 */
export function resolveCommand(name: string): ResolvedCommand {
  let candidates: string[];
  try {
    candidates = execFileSync("where.exe", [name], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    throw new Error(`PATH 中找不到命令：${name}`);
  }

  // 1) PATH 里直接就有 .exe（grok 是这种）
  const direct = candidates.find((c) => c.toLowerCase().endsWith(".exe") && existsSync(c));
  if (direct) return { exe: direct, args: [], via: "direct" };

  // 2) 从 .cmd shim 里把目标抠出来
  const cmd = candidates.find((c) => c.toLowerCase().endsWith(".cmd") && existsSync(c));
  if (cmd) {
    const body = readFileSync(cmd, "utf8");
    const dp0 = dirname(cmd);
    const expand = (p: string): string => normalize(p.replace(/%dp0%\\?/gi, `${dp0}\\`));

    // 2a) shim 直接调一个 .exe（claude / opencode）。
    //     必须跳过 node.exe —— npm 的 shim 里有 `IF EXIST "%dp0%\node.exe"` 这种探测行，
    //     那是启动器不是目标，误命中会起错进程。
    for (const m of body.matchAll(/"([^"]+\.exe)"/gi)) {
      const hit = m[1];
      if (!hit || /[\\/]node\.exe$/i.test(hit)) continue;
      const target = expand(hit);
      if (existsSync(target)) return { exe: target, args: [], via: `cmd-shim:${cmd}` };
    }

    // 2b) shim 走 node 跑一个 .js（codex / pi）。
    //     不去匹配 node 的路径 —— npm 用的是 "%_prog%" 变量，匹配不到。
    for (const m of body.matchAll(/"([^"]+\.(?:js|mjs|cjs))"/gi)) {
      const hit = m[1];
      if (!hit) continue;
      const script = expand(hit);
      if (existsSync(script)) {
        return { exe: process.execPath, args: [script], via: `cmd-shim-node:${cmd}` };
      }
    }
  }

  throw new Error(
    `无法把 ${name} 解析成可执行文件。PATH 候选：${candidates.join(", ") || "(无)"}`,
  );
}
