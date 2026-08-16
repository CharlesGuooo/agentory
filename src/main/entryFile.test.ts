import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEntryFile, saveEntryFile } from "./entryFile";

/**
 * 工作集和收藏夹共用的落盘外壳。它自己一直没有直接测试 ——
 * 两边的 store 测试各自覆盖了「读」的语义，但**都是在 load 之后立刻检查文件没被覆盖**，
 * 没有一条走到「load 跳过一条之后，再正常写一次」。
 *
 * 而那正是销毁链：坏文件只在**下一次正常写入之前**是安全的。
 */

const scratch = mkdtempSync(join(tmpdir(), "agentory-entryfile-"));
let n = 0;
const file = (): string => join(scratch, `f${++n}.json`);

interface Row {
  id: string;
}
/** 没有 id 就算坏条目 —— 模拟 workspace/favorites 各自的字段校验。 */
const parseOne = (raw: unknown): Row => {
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== "string") throw new Error("缺少 id");
  return { id };
};

const write = (p: string, sessions: unknown[]): void => {
  writeFileSync(p, JSON.stringify({ version: 1, sessions }, null, 2));
};
const idsOnDisk = (p: string): unknown[] =>
  (JSON.parse(readFileSync(p, "utf8")) as { sessions: { id?: unknown }[] }).sessions.map(
    (s) => s.id,
  );

describe("坏条目在下一次正常写入之后还在不在", () => {
  /**
   * **这是这个文件存在的理由那句话的真正考验。**
   *
   * 文件头写着「任何读取失败都只返回空列表 + 告警，绝不写回 —— 文件可能是用户手改坏的，
   * 读不动就把它抹了，等于替用户销毁记录」。而这条保证到今天只成立到**下一次正常写入**为止：
   * 20 条里坏了 1 条 → 读出 19 条 + 1 条告警 → 用户新加一条 → 把 20 条写回去 →
   * 那条坏的连同它记录的会话，永远没了。
   */
  it("坏条目被跳过之后再写一次，原始文件仍然留有它的备份", () => {
    const p = file();
    write(p, [{ id: "好的1" }, { 这条: "坏的", 没有: "id" }, { id: "好的2" }]);

    const loaded = loadEntryFile(p, parseOne);
    expect(loaded.entries.map((e) => e.id)).toEqual(["好的1", "好的2"]);
    expect(loaded.warnings.filter((w) => w.startsWith("跳过条目"))).toHaveLength(1);
    expect(loaded.warnings.some((w) => w.includes("已备份到"))).toBe(true);

    // 用户接着正常用：新加一条 → commit → 整份写回
    saveEntryFile(p, [...loaded.entries, { id: "新加的" }]);

    // 活文件里那条坏的确实没了（这是对的，它读不动）
    expect(idsOnDisk(p)).toEqual(["好的1", "好的2", "新加的"]);
    // 但它必须在别处还留着 —— 否则「绝不替用户销毁记录」是句假话
    const backup = JSON.parse(readFileSync(`${p}.bak`, "utf8")) as {
      sessions: Record<string, unknown>[];
    };
    expect(backup.sessions).toHaveLength(3);
    expect(backup.sessions[1]).toEqual({ 这条: "坏的", 没有: "id" });
  });

  it("整份文件坏掉时也留备份 —— 那种情况丢的是全部记录", () => {
    const p = file();
    const raw = "{ 这不是 JSON";
    writeFileSync(p, raw);

    const loaded = loadEntryFile(p, parseOne);
    expect(loaded.entries).toEqual([]);
    expect(loaded.warnings.some((w) => w.includes("不是合法 JSON"))).toBe(true);
    expect(readFileSync(`${p}.bak`, "utf8")).toBe(raw);

    saveEntryFile(p, [{ id: "新的" }]);
    // 活文件被新内容取代，但原文原样留着
    expect(idsOnDisk(p)).toEqual(["新的"]);
    expect(readFileSync(`${p}.bak`, "utf8")).toBe(raw);
  });

  it("读得干干净净时不留备份 —— 不给每个正常用户的目录里塞垃圾", () => {
    const p = file();
    write(p, [{ id: "a" }, { id: "b" }]);
    const loaded = loadEntryFile(p, parseOne);
    expect(loaded.warnings).toEqual([]);
    expect(() => readFileSync(`${p}.bak`, "utf8")).toThrow();
  });

  it("文件根本不存在时不留备份，也不算错误", () => {
    const p = file();
    const loaded = loadEntryFile(p, parseOne);
    expect(loaded).toEqual({ entries: [], warnings: [] });
    expect(() => readFileSync(`${p}.bak`, "utf8")).toThrow();
  });

  /**
   * 备份**只在第一次坏读时写**。否则每次启动都覆盖一遍，
   * 用户修好文件再启动一次，备份就被修好的版本盖掉了 —— 那时才最需要旧的那份。
   */
  it("第二次坏读不覆盖第一次的备份", () => {
    const p = file();
    write(p, [{ 第一版: "坏的" }]);
    loadEntryFile(p, parseOne);

    write(p, [{ 第二版: "也坏" }]);
    loadEntryFile(p, parseOne);

    const backup = JSON.parse(readFileSync(`${p}.bak`, "utf8")) as {
      sessions: Record<string, unknown>[];
    };
    expect(backup.sessions[0]).toEqual({ 第一版: "坏的" });
  });
});
