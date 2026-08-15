import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { spawnSession } from "./session";

// 本项目是 Windows 专用（见 DESIGN.md §1），测试直接用 cmd.exe。
const scratch = mkdtempSync(join(tmpdir(), "agentory-test-"));
afterAll(() => {
  // Windows 下刚退出的进程会短暂占着 cwd 的句柄，rm 会 EBUSY。
  // 重试几次；仍失败就算了 —— 临时目录残留无害，不该让整个测试文件挂掉。
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 留个临时目录而已 */
  }
});

/**
 * 剥掉 ANSI 转义序列。PTY 的输出是终端流，混着 OSC 标题设置、光标显隐等控制序列，
 * 直接按行解析会读到 `]0;C:\windows\SYSTEM32\cmd.exe` 这种东西。
 */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-Z\\-_]/g, ""); // 双字符转义
}

/** 从输出里挑出看起来像绝对路径的那一行。 */
function findPathLine(out: string): string {
  const lines = stripAnsi(out)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hit = lines.find((l) => /^[A-Za-z]:\\/.test(l));
  if (!hit) throw new Error(`输出里没有绝对路径行：${JSON.stringify(lines)}`);
  return hit;
}

/** 起一个会话，收集全部输出直到退出。 */
function runToEnd(opts: Parameters<typeof spawnSession>[0]): Promise<{ out: string; code: number }> {
  return new Promise((res, rej) => {
    const s = spawnSession(opts);
    let out = "";
    s.onData((c) => (out += c));
    s.onExit(({ exitCode }) => res({ out, code: exitCode }));
    setTimeout(() => {
      s.kill();
      rej(new Error("会话在 10 秒内没有退出"));
    }, 10_000);
  });
}

describe("spawnSession", () => {
  it("子进程的 cwd 与请求的一致", async () => {
    const { out, code } = await runToEnd({
      command: "cmd.exe",
      args: ["/c", "cd"],
      cwd: scratch,
      cols: 80,
      rows: 24,
    });
    expect(code).toBe(0);
    // cmd 的 `cd` 会打印当前目录。用 resolve 归一化大小写与短路径差异。
    expect(resolve(findPathLine(out))).toBe(resolve(scratch));
  });

  it("工作目录不存在时抛错，且错误信息里含那个路径", () => {
    const missing = join(scratch, "这个目录不存在");
    // 同步抛出 —— 在调用 node-pty 之前就拦下，所以不可能留下僵尸 PTY
    expect(() => spawnSession({ command: "cmd.exe", cwd: missing, cols: 80, rows: 24 }))
      .toThrow(missing);
  });

  it("命令不在 PATH 时抛错，且错误信息里含那个命令名", () => {
    expect(() =>
      spawnSession({ command: "agentory-绝不存在的命令", cwd: scratch, cols: 80, rows: 24 }),
    ).toThrow(/agentory-绝不存在的命令/);
  });

  it("初始尺寸就是请求的尺寸，不是某个默认值", async () => {
    // mode con 会打印控制台的行列数
    const { out } = await runToEnd({
      command: "cmd.exe",
      args: ["/c", "mode", "con"],
      cwd: scratch,
      cols: 111,
      rows: 37,
    });
    const nums = out.match(/\d+/g)?.map(Number) ?? [];
    expect(nums).toContain(111);
    expect(nums).toContain(37);
  });

  it("关键 ANSI 序列全部送达（ConPTY 会重排，但不丢）", async () => {
    // 发一段精确的字节：SGR 真彩、DECSCUSR 光标形状、备用屏幕缓冲切换。
    // 这三类正是探针验证过、ConPTY 可能动手脚的序列（见 findings.md）。
    //
    // 注意断言的是"每个序列都到了"，不是"它们字节相邻"。
    // ConPTY 不透传原始字节流 —— 它按最终屏幕状态重绘，会插入自己的
    // 前导（?9001h/?1004h/?25l）、[2J、[H 定位，并重排序列顺序。
    // 实测输入 `<色码>X<reset><[3 q><?1049h><?1049l>` 收到的是
    // `...[3 q [2J [m [38;2;215;119;87m [H X ... [?1049h ...`。
    // 语义一致（X 被涂成那个 RGB、光标形状生效、进了备用屏），渲染结果相同，
    // 所以相邻关系不是保真度的一部分。
    const payload = "\\x1b[38;2;215;119;87mX\\x1b[0m\\x1b[3 q\\x1b[?1049h\\x1b[?1049l";
    const { out } = await runToEnd({
      command: process.execPath,
      args: ["-e", `process.stdout.write("${payload}")`],
      cwd: scratch,
      cols: 80,
      rows: 24,
    });
    expect(out).toContain("\x1b[38;2;215;119;87m"); // 真彩不被降级
    expect(out).toContain("\x1b[3 q"); // DECSCUSR 不被吞
    expect(out).toContain("\x1b[?1049h"); // 备用屏切换不被吞
    expect(out).toContain("X"); // 内容本身
  });

  it("写进去的输入原样到达子进程", async () => {
    // 子进程把 stdin 读到的第一行原样回显，用一个不会被 TUI 改写的标记
    const s = spawnSession({
      command: process.execPath,
      args: ["-e", "process.stdin.once('data', d => { process.stdout.write('GOT:' + d.toString().trim()); process.exit(0); })"],
      cwd: scratch,
      cols: 80,
      rows: 24,
    });
    let out = "";
    s.onData((c) => (out += c));
    const done = new Promise<void>((res) => s.onExit(() => res()));
    setTimeout(() => s.write("hello-agentory\r"), 400);
    await done;
    expect(stripAnsi(out)).toContain("GOT:hello-agentory");
  });

  it("resize 之后子进程看到的是新尺寸", async () => {
    const s = spawnSession({ command: "cmd.exe", cwd: scratch, cols: 80, rows: 24 });
    let out = "";
    s.onData((c) => (out += c));
    const done = new Promise<void>((res) => s.onExit(() => res()));

    await new Promise((r) => setTimeout(r, 600));
    s.resize(133, 41);
    await new Promise((r) => setTimeout(r, 400));
    s.write("mode con\r");
    await new Promise((r) => setTimeout(r, 900));
    s.write("exit\r");
    await done;

    const nums = stripAnsi(out).match(/\d+/g)?.map(Number) ?? [];
    expect(nums, "mode con 应该报告 resize 之后的行列数").toContain(133);
    expect(nums).toContain(41);
  });

  it("子进程退出后 onExit 带出退出码；对已死的会话再 kill 不抛错", async () => {
    const s = spawnSession({
      command: "cmd.exe",
      args: ["/c", "exit 7"],
      cwd: scratch,
      cols: 80,
      rows: 24,
    });
    const info = await new Promise<{ exitCode: number }>((res) => s.onExit(res));
    expect(info.exitCode).toBe(7);
    // 清理路径上会对所有会话调 kill，包括已经自己退掉的那些 —— 不能因此炸掉
    expect(() => s.kill()).not.toThrow();
  });

  it("暴露子进程的 pid", () => {
    const s = spawnSession({ command: "cmd.exe", args: ["/c", "exit"], cwd: scratch, cols: 80, rows: 24 });
    expect(s.pid).toBeGreaterThan(0);
    s.kill();
  });
});
