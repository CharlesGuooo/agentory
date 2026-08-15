import type { WorkspaceEntry } from "./model";

export interface RestoreOutcome {
  entry: WorkspaceEntry;
  ok: boolean;
  /** 仅在失败时有值。要能直接展示给用户，所以内容是人话不是堆栈。 */
  error?: string;
}

/**
 * 串行恢复一批会话。
 *
 * **一次只起一个**：实测负载是 8 个 claude 会话拉起约 15×8 个 MCP 子进程，
 * 单机破百（`README.md` §10）。并行恢复 6 个 = 瞬间近百进程，外加 6 份上下文重载。
 *
 * **一个失败不中断其余**：失败多半是局部原因（某个目录被删了），
 * 没有理由让它拖垮剩下五个。失败原因逐条带出，结束后一起汇报。
 *
 * 刻意不建作业队列（同 D-13 的精神）：恢复不跨应用重启 ——
 * 子进程随应用消亡，所以不需要持久化进度，一个 `for` 循环就够。
 */
export async function restoreSerially(
  entries: WorkspaceEntry[],
  start: (entry: WorkspaceEntry) => Promise<void>,
  onProgress: (done: number, total: number) => void,
): Promise<RestoreOutcome[]> {
  const out: RestoreOutcome[] = [];
  const total = entries.length;
  let done = 0;

  for (const entry of entries) {
    try {
      await start(entry);
      out.push({ entry, ok: true });
    } catch (e) {
      out.push({ entry, ok: false, error: (e as Error).message });
    }
    done += 1;
    // 失败也计入 —— 进度反映的是"处理完几个"，不是"成功几个"
    onProgress(done, total);
  }

  return out;
}
