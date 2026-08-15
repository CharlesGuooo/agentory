import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkUninstall, installSkill } from "./install";
import { isSkillDir, readSkills } from "./skills";

const scratch = mkdtempSync(join(tmpdir(), "agentory-inst-"));
let n = 0;
const fresh = (): string => {
  const p = join(scratch, `case${n++}`);
  mkdirSync(p, { recursive: true });
  return p;
};

/** 造一个带子目录的 skill —— pdf 那种（SKILL.md + scripts/ + references/）。 */
function makeSkill(root: string, name: string): string {
  const p = join(root, name);
  mkdirSync(join(p, "scripts"), { recursive: true });
  writeFileSync(join(p, "SKILL.md"), `---\nname: ${name}\n---\n正文`);
  writeFileSync(join(p, "scripts", "run.py"), "print(1)");
  return p;
}

describe("装：复制目录", () => {
  it("整个目录都过去了，子目录和文件都在", () => {
    const box = fresh();
    const src = makeSkill(join(box, "from"), "pdf");
    const targetRoot = join(box, "to");

    const r = installSkill(src, targetRoot, "pdf");
    expect(r.ok, r.error).toBe(true);
    expect(existsSync(join(targetRoot, "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(targetRoot, "pdf", "scripts", "run.py"))).toBe(true);
    expect(readFileSync(join(targetRoot, "pdf", "SKILL.md"), "utf8")).toContain("name: pdf");

    // 装完之后读取器就能看见它 —— 这才是「装上了」的意思
    expect(readSkills(targetRoot).entries.map((e) => e.name)).toEqual(["pdf"]);
  });

  it("目标根不存在会自动建", () => {
    const box = fresh();
    const src = makeSkill(join(box, "from"), "a");
    const r = installSkill(src, join(box, "深", "几", "层"), "a");
    expect(r.ok, r.error).toBe(true);
  });

  it("源目录没有 SKILL.md 就拒绝", () => {
    const box = fresh();
    const notSkill = join(box, "from", "随便一个目录");
    mkdirSync(notSkill, { recursive: true });
    writeFileSync(join(notSkill, "readme.txt"), "x");

    const r = installSkill(notSkill, join(box, "to"), "随便一个目录");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("没有 SKILL.md");
  });

  it("已经装了就拒绝，不覆盖", () => {
    const box = fresh();
    const src = makeSkill(join(box, "from"), "dup");
    const targetRoot = join(box, "to");
    expect(installSkill(src, targetRoot, "dup").ok).toBe(true);

    const again = installSkill(src, targetRoot, "dup");
    expect(again.ok).toBe(false);
    expect(again.error).toContain("已经装了");
  });

  /** name 来自渲染层。不能让它带着 ../ 跑出根目录。 */
  it("名字里带 ../ 会被挡住", () => {
    const box = fresh();
    const src = makeSkill(join(box, "from"), "x");
    const r = installSkill(src, join(box, "to"), join("..", "..", "跑出去"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("越界");
  });
});

describe("卸：校验（真正的删除走系统回收站，在 ipc 层）", () => {
  it("正常情况放行", () => {
    const box = fresh();
    const root = join(box, "skills");
    const p = makeSkill(root, "ok-one");
    expect(checkUninstall(p, [root])).toBeNull();
  });

  /** 第一道闸：不是 skill 目录就不许动 —— 防止把别的东西丢进回收站。 */
  it("不是 skill 目录就拒绝", () => {
    const box = fresh();
    const root = join(box, "skills");
    const p = join(root, "只是个目录");
    mkdirSync(p, { recursive: true });
    expect(checkUninstall(p, [root])).toContain("没有 SKILL.md");
  });

  /** 第二道闸：路径必须正好在某个已知根的下一层 —— 防止渲染层传来任意路径。 */
  it("不在已知 skills 根里就拒绝", () => {
    const box = fresh();
    const root = join(box, "skills");
    const outside = makeSkill(join(box, "别的地方"), "偷渡");
    expect(checkUninstall(outside, [root])).toContain("不在任何已知的 skills 目录里");
  });

  it("在根的更深层也拒绝 —— 只允许下一层", () => {
    const box = fresh();
    const root = join(box, "skills");
    const deep = makeSkill(join(root, "中间层"), "深的");
    expect(checkUninstall(deep, [root])).toContain("不在任何已知的 skills 目录里");
  });

  it("路径不存在就拒绝", () => {
    const box = fresh();
    expect(checkUninstall(join(box, "没有"), [box])).toContain("目录不存在");
  });

  it("多个允许的根，命中任意一个即可", () => {
    const box = fresh();
    const r1 = join(box, "s1");
    const r2 = join(box, "s2");
    const p = makeSkill(r2, "在第二个根里");
    expect(checkUninstall(p, [r1, r2])).toBeNull();
  });
});

describe("skill 目录的判据", () => {
  it("含 SKILL.md 才算", () => {
    const box = fresh();
    const yes = makeSkill(box, "yes");
    const no = join(box, "no");
    mkdirSync(no, { recursive: true });
    expect(isSkillDir(yes)).toBe(true);
    expect(isSkillDir(no)).toBe(false);
  });
});
