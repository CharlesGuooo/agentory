import { ipcMain, shell } from "electron";
import { scanHarness } from "./all";
import { checkUninstall, installSkill } from "./install";
import { allSkillRoots, skillsRoot } from "./skills";
import type { AgentId } from "../sessions/types";
import type { HarnessMatrix, Scope } from "./types";

/**
 * harness 矩阵的 IPC。
 *
 * **零缓存、零网络、零子进程。** 五个本地小文件 + 五个目录，毫秒级读完，
 * 每次打开面板重算就行。不写缓存文件还有一个理由：
 * 配置里有明文凭证，而缓存文件是它们唯一可能被**持久化到第二个地方**的路径。
 */

export interface SkillActionResult {
  ok: boolean;
  error?: string;
}

export function registerHarnessIpc(): void {
  ipcMain.handle("harness:scan", (_e, scope: Scope): HarnessMatrix => scanHarness(scope));

  /**
   * 装：把**已经存在于另一个 agent**（或用户选的目录）的 skill 复制过来。
   *
   * 来源只能是机器上已有的东西 —— 这一刀不联网、不装远端的东西。
   */
  ipcMain.handle(
    "harness:installSkill",
    (_e, req: { source: string; agent: AgentId; scope: Scope; name: string }): SkillActionResult => {
      const r = installSkill(req.source, skillsRoot(req.agent, req.scope), req.name);
      return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
    },
  );

  /**
   * 卸：**丢进系统回收站，不是删除。**
   *
   * `shell.trashItem` 是 Electron 自带的平台能力，用户能自己从资源管理器恢复 ——
   * 所以这里不需要一个确认弹窗，也不可能造成不可逆的损失。
   *
   * 校验（必须是 skill 目录、必须正好在某个已知 skills 根下一层）在 `checkUninstall` 里，
   * 那部分是纯函数、有单测；这里只负责调用平台 API。
   */
  ipcMain.handle(
    "harness:uninstallSkill",
    async (_e, req: { path: string; scope: Scope }): Promise<SkillActionResult> => {
      const roots = allSkillRoots(req.scope);
      const why = checkUninstall(req.path, roots);
      if (why !== null) return { ok: false, error: why };
      try {
        await shell.trashItem(req.path);
      } catch (e) {
        return { ok: false, error: `丢进回收站失败：${(e as Error).message}` };
      }
      return { ok: true };
    },
  );
}
