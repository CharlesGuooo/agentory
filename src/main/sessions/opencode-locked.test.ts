import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSY_TIMEOUT_MS, defaultOpenCodeDb, scanOpenCode } from "./opencode";
import { scanAll } from "./scan";

/**
 * **库被别的进程独占锁着时会怎样。**
 *
 * `BUSY_TIMEOUT_MS` 就是为这个存在的 —— 那次事故值 166 条会话：opencode 自己在写库，
 * 我们的扫描拿不到锁，`sessions` 悄悄变成空数组，历史计数从 437 掉到 271，
 * 界面上零解释。而它是**并发跑测试碰巧撞出来的**，属于运气。
 *
 * 这里把那个状态造出来：另开一个连接跑 `BEGIN EXCLUSIVE` 占住写锁，再去扫。
 * 要验的是两件事之一必须成立 ——
 * **要么按时拿到数据，要么在 `problems` 里说出来。绝不能是静悄悄的空列表。**
 */

const real = defaultOpenCodeDb();
const hasReal = existsSync(real);

describe.skipIf(!hasReal)("opencode 的库被独占锁住", () => {
  /** 拷一份真库到临时目录 —— 绝不在用户的真库上开事务。 */
  const copy = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "agentory-oc-lock-"));
    const p = join(dir, "opencode.db");
    copyFileSync(real, p);
    return p;
  };

  it("没有锁的时候能读到会话（对照组，证明这份拷贝是好的）", () => {
    const r = scanOpenCode(copy());
    expect(r.problems).toEqual([]);
    expect(r.sessions.length).toBeGreaterThan(0);
  });

  /**
   * opencode 的库是 **WAL** 模式（实测 `PRAGMA journal_mode` = wal）。
   * WAL 下写事务**不挡只读连接** —— 所以这条验的是「opencode 正在写的时候，
   * 我们照样读得到」，也就是最常见的那个情形。
   */
  it("WAL：对方正在写事务里，我们照样按时读到全部会话", () => {
    const p = copy();
    const writer = new DatabaseSync(p);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const t0 = Date.now();
      const r = scanOpenCode(p);
      expect(Date.now() - t0).toBeLessThan(BUSY_TIMEOUT_MS);
      expect(r.sessions.length).toBeGreaterThan(0);
      expect(r.problems).toEqual([]);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  /**
   * 真正会被挡住的那一种：**回滚日志模式**下 `BEGIN EXCLUSIVE` 连读者一起挡。
   * 这条才走到 `busy_timeout`，验的是「等，但不会永远等，而且失败要说出来」。
   *
   * 那次 166 条会话消失时报的就是 `database is locked` —— 不管是哪种模式造成的，
   * 要挡住的失败模式只有一个：**静悄悄地返回空列表**。
   */
  it("被真正挡住时：最多等 busy_timeout，然后大声失败（绝不是静悄悄的空列表）", () => {
    const p = copy();
    const blocker = new DatabaseSync(p);
    blocker.exec("PRAGMA journal_mode = DELETE");
    blocker.exec("BEGIN EXCLUSIVE");
    blocker.exec("CREATE TABLE IF NOT EXISTS _lock_probe (x)");
    try {
      const t0 = Date.now();
      let threw: Error | null = null;
      let r: ReturnType<typeof scanOpenCode> | null = null;
      try {
        r = scanOpenCode(p);
      } catch (e) {
        threw = e as Error;
      }
      const spent = Date.now() - t0;
      // 等是对的，永远等不是 —— 留一倍余量给慢机器
      expect(spent).toBeLessThan(BUSY_TIMEOUT_MS * 2 + 1000);

      if (threw !== null) {
        // 抛出来完全可以：`scanAll` 会把它变成一条 problem（见下面那个 describe）
        expect(threw.message).toMatch(/lock|busy/i);
        return;
      }
      // 没抛就必须真读到东西。**空列表 + 零 problem 正是这条要挡的那个失败模式。**
      expect(r!.sessions.length > 0 || r!.problems.length > 0).toBe(true);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

});

/**
 * 上一条允许 `scanOpenCode` 抛错，因为**抛错是可以的** —— 只要调用方把它变成
 * 一条用户看得见的 problem。`scanAll` 就是干这个的，下面两条钉住那个转换。
 *
 * 这一半不需要真库，所以不跟着 skip。
 */
describe("扫描器出问题时，problems 必须带出来", () => {
  it("抛错的扫描器变成一条 problem，而不是悄悄少掉的会话", () => {
    const r = scanAll([
      {
        agent: "opencode",
        run: () => {
          throw new Error("database is locked");
        },
      },
    ]);
    expect(r.sessions).toEqual([]);
    // 这一条就是 166 条会话消失那次在界面上本该出现的字
    expect(r.problems).toEqual(["[opencode] 扫描失败：database is locked"]);
  });

  it("一个扫描器炸了不影响别的 —— 其余照常返回", () => {
    const r = scanAll([
      {
        agent: "opencode",
        run: () => {
          throw new Error("database is locked");
        },
      },
      { agent: "claude", run: () => ({ sessions: [], problems: ["某个文件读不动"] }) },
    ]);
    expect(r.problems).toEqual(["[opencode] 扫描失败：database is locked", "[claude] 某个文件读不动"]);
  });
});
