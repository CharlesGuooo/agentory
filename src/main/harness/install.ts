import { t } from "../../shared/i18n";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isSkillDir } from "./skills";

/**
 * skill 的装与卸。
 *
 * ## 为什么这件事可以做，而 MCP 的装卸不做
 *
 * 因为 skill 是**一个目录**。Anthropic 2025-12-18 发布 Agent Skills 规范后，
 * 到 2026-06 约 40 个产品读同一份 `SKILL.md` —— 五个 agent 的 skill 目录结构完全相同，
 * 所以「装到另一个 agent」就是复制目录，没有格式互译、没有密钥、没有竞态。
 *
 * MCP 的装卸要改配置文件：四套字段名互译、TOML 往返会抹掉用户的注释、
 * 配置文件正被 agent 高频重写。那是另一个数量级的风险，这一刀不做。
 *
 * ## 卸载不删文件
 *
 * 用 `shell.trashItem()` 丢进系统回收站（调用在 `ipc.ts`，因为它是 Electron API）。
 * 这是「绝不替用户销毁记录」（`entryFile.ts` 的既有原则）在这个功能上的形态：
 * 用户可以自己从资源管理器恢复，所以也就不需要一个确认弹窗。
 */

export interface InstallOutcome {
  ok: boolean;
  /** 失败原因，给用户看的一句话。 */
  error?: string;
  /** 成功时目标目录的绝对路径。 */
  path?: string;
}

/**
 * 把一个 skill 目录复制到某个 agent 的 skills 根下。
 *
 * 三道闸：源必须是真的 skill 目录、目标不能已经存在、目标必须落在给定的根里面。
 */
export function installSkill(source: string, targetRoot: string, name: string): InstallOutcome {
  if (!isSkillDir(source)) return { ok: false, error: t("hx.noSkillMd", { src: source }) };

  const target = join(targetRoot, name);
  // 防路径穿越：name 来自渲染层，不能让它带着 ../ 跑出根目录
  if (!resolve(target).startsWith(resolve(targetRoot))) {
    return { ok: false, error: t("hx.pathEscape", { name }) };
  }
  if (existsSync(target)) return { ok: false, error: t("hx.alreadyThere", { target }) };

  try {
    mkdirSync(targetRoot, { recursive: true });
    // 整个目录复制 —— skill 可以带 scripts/ references/ assets/
    cpSync(source, target, { recursive: true });
  } catch (e) {
    return { ok: false, error: t("hx.copyFailed", { msg: (e as Error).message }) };
  }
  return { ok: true, path: target };
}

/**
 * 卸载前的校验。返回 `null` 表示可以卸，否则返回拒绝理由。
 *
 * **真正的删除动作不在这里** —— 这个函数刻意保持纯粹可测，
 * 而 `shell.trashItem()` 是 Electron API，调用在 `ipc.ts`。
 *
 * 两道闸缺一不可：
 * 1. 必须是真的 skill 目录（含 `SKILL.md`）—— 防止把别的东西丢进回收站
 * 2. 必须**正好**位于某个已知 skills 根的下一层 —— 防止渲染层传来任意路径
 */
export function checkUninstall(path: string, allowedRoots: string[]): string | null {
  if (!existsSync(path)) return t("hx.noSuchDir", { path });
  if (!isSkillDir(path)) return t("hx.notASkill", { path });

  const parent = resolve(dirname(path));
  if (!allowedRoots.some((r) => resolve(r) === parent)) {
    return t("hx.outsideSkills", { path });
  }
  return null;
}
