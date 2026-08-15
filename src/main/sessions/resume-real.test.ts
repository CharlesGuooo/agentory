import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveCommand } from "../terminal/resolve";
import { spawnSession } from "../terminal/session";
import { scanAllAgents } from "./all";
import { resumeCommand } from "./resume";
import type { AgentId, Session } from "./types";

/**
 * 真机恢复验证 —— 本变更的成败标准。
 *
 * **不是「进程起来了」就算过**，要证明那个会话自己的内容真的回来了。
 * 用的信号是终端窗口标题（OSC 0）：启动早期是 `claude`，全新会话稳定后是
 * `✳ Claude Code`，而恢复出来的会变成该会话自己的主题。
 * 比断言屏幕上某段文字稳 —— 屏幕内容取决于滚动位置。
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** 取终端设置的窗口标题（OSC 0）。用 fromCharCode 拼正则，避免控制字符穿层丢失。 */
function windowTitle(out: string): string | null {
  const re = new RegExp(`${ESC}\\]0;([^${BEL}${ESC}]*)${BEL}`, "g");
  const titles = [...out.matchAll(re)]
    .map((m) => m[1] ?? "")
    // 杀进程时 ConPTY 会补一个「清空标题」的 OSC 0，它才是流里最后一个 —— 跳过空的
    .filter((t) => t.trim().length > 0);
  return titles.length > 0 ? titles[titles.length - 1]! : null;
}

/**
 * 可恢复的候选，按最近活动排序。
 *
 * 返回**列表**而不是单个：实测发现有的会话工作目录是整个家目录，
 * claude 在那里启动要扫海量文件，30 秒都到不了渲染 ——
 * 押单个候选会让这条测试随数据变化周期性变红。
 */
function resumableCandidates(agent: AgentId): Session[] {
  const anHourAgo = Date.now() - 3600_000;
  return scanAllAgents()
    .sessions.filter((s) => s.agent === agent && s.cwdExists && s.cwd !== null)
    // 跳过可能正在运行的（见 design.md 的 Open Question）
    .filter((s) => s.lastActivity.getTime() < anHourAgo)
    .filter((s) => {
      try {
        // 跳过超大文件：本机存在 195 MB 的单会话
        return statSync(s.source).size < 20 * 1024 * 1024;
      } catch {
        return true;
      }
    });
}

/**
 * 起一个会话，**轮询直到条件满足**（或超时）后杀掉，返回收到的全部输出。
 *
 * 刻意不用固定等待时长：agent 的启动耗时随会话大小、工作目录规模、机器负载浮动，
 * 固定窗口会让这条测试周期性变红 —— 而周期性变红的测试会训练人忽略红色。
 */
async function captureUntil(
  cmd: { command: string; args: string[]; cwd: string },
  done: (out: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const r = resolveCommand(cmd.command);
  const s = spawnSession({
    command: r.exe,
    args: [...r.args, ...cmd.args],
    cwd: cmd.cwd,
    cols: 120,
    rows: 34,
  });
  let out = "";
  s.onData((c) => (out += c));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !done(out)) {
    await new Promise((res) => setTimeout(res, 250));
  }
  s.kill();
  await new Promise((res) => setTimeout(res, 300));
  return out;
}

/** 启动早期的临时标题 与 全新会话的默认标题 —— 都不算「历史回来了」。 */
const BOOTSTRAP = ["claude", "✳ Claude Code"];

describe("真机恢复", () => {
  it(
    "claude：恢复后窗口标题变成该会话自己的主题",
    async (ctx) => {
      const candidates = resumableCandidates("claude").slice(0, 3);
      if (candidates.length === 0) return void ctx.skip();

      const settled = (out: string): boolean => {
        const t = windowTitle(out);
        return t !== null && !BOOTSTRAP.includes(t);
      };

      const tried: string[] = [];
      for (const s of candidates) {
        const cmd = resumeCommand(s);
        expect(cmd.args).toEqual(["--resume", s.sessionId]);
        expect(cmd.cwd).toBe(s.cwd);

        const title = windowTitle(await captureUntil(cmd, settled, 45_000));
        tried.push(`${s.sessionId.slice(0, 8)} @ ${s.cwd} -> ${title}`);
        if (title !== null && !BOOTSTRAP.includes(title)) {
          console.log(`\n  恢复后标题: ${title}\n  会话: ${s.sessionId}\n  cwd: ${s.cwd}\n`);
          return; // 通过：历史确实回来了
        }
      }
      throw new Error(`没有一个候选恢复出会话自己的标题：\n  ${tried.join("\n  ")}`);
    },
    180_000,
  );

  it(
    "codex：用子命令形式恢复，且能真的起来",
    async (ctx) => {
      const s = resumableCandidates("codex")[0];
      if (!s) return void ctx.skip();

      const cmd = resumeCommand(s);
      // 唯一用子命令的那个 —— README §8 的验收标准
      expect(cmd.args[0]).toBe("resume");
      expect(cmd.args).not.toContain("--resume");

      const out = await captureUntil(cmd, (o) => o.length > 2000, 45_000);
      console.log(`\n  codex 恢复 ${s.sessionId}：收到 ${out.length} 字节\n`);
      expect(out.length).toBeGreaterThan(500);
    },
    120_000,
  );
});
