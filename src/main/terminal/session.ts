import { existsSync, statSync } from "node:fs";
import { spawn as ptySpawn, type IPty } from "node-pty";

/**
 * 一个 PTY 会话。刻意不 import Electron —— 这样它能在纯 Node 下被 vitest 起真进程测试，
 * IPC 接线是上面薄薄一层。
 */
export interface SpawnOptions {
  command: string;
  args?: string[];
  /** 必须是已存在的目录。真实 cwd 是产品的核心不变量（DESIGN.md §2）。 */
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
}

export interface ExitInfo {
  exitCode: number;
}

export interface PtySession {
  readonly pid: number;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (info: ExitInfo) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export function spawnSession(opts: SpawnOptions): PtySession {
  // cwd 的检查放在最前面 —— 在碰 node-pty 之前失败，所以不可能留下僵尸 PTY。
  if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
    throw new Error(`工作目录不存在或不是目录：${opts.cwd}`);
  }

  let pty: IPty;
  try {
    pty = ptySpawn(opts.command, opts.args ?? [], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // 不设 COLORTERM。实测五个 agent 都无视它、一律直发 24 位真彩
      // （见 DESIGN.md D-3 的实测修正），所以那个"降级到 16 色"的旋钮不存在。
    });
  } catch (e) {
    // node-pty 的原始报错是 "Cannot create process, error code: 2"，不含命令名。
    // 包一层，把命令名带上，否则调用方拿到的信息不足以定位。
    throw new Error(`无法启动命令 ${opts.command}：${(e as Error).message}`, { cause: e });
  }

  return {
    pid: pty.pid,
    onData: (cb) => void pty.onData(cb),
    onExit: (cb) => void pty.onExit(({ exitCode }) => cb({ exitCode })),
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => {
      try {
        pty.kill();
      } catch {
        // 进程可能已经自己退了 —— kill 一个死进程不是错误
      }
    },
  };
}
