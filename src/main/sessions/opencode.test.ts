import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanOpenCode } from "./opencode";

const scratch = mkdtempSync(join(tmpdir(), "agentory-oc-"));
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 临时目录残留无害 */
  }
});

/** 造一个最小的 OpenCode 库。只放扫描器真正读的那几列。 */
function makeDb(rows: Array<[string, string, string, number]>): string {
  const p = join(scratch, `db-${rows.length}-${Math.trunc(rows[0]?.[3] ?? 0)}.db`);
  const db = new DatabaseSync(p);
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  );
  const ins = db.prepare("INSERT INTO session (id, directory, title, time_updated) VALUES (?,?,?,?)");
  for (const r of rows) ins.run(...r);
  db.close();
  return p;
}

describe("scanOpenCode", () => {
  it("字段映射：id/directory/title/time_updated → sessionId/cwd/nativeTitle/lastActivity", () => {
    const p = makeDb([["s1", scratch, "整理知识库", 1_754_000_000_000]]);
    const r = scanOpenCode(p);
    expect(r.problems).toEqual([]);
    const s = r.sessions[0]!;
    expect(s.agent).toBe("opencode");
    expect(s.sessionId).toBe("s1");
    expect(s.cwd).toBe(scratch);
    expect(s.nativeTitle).toBe("整理知识库");
    expect(s.lastActivity.getTime()).toBe(1_754_000_000_000);
    // 数据库里的时间是 agent 自己写的，权威，不是猜的
    expect(s.lastActivityExact).toBe(true);
  });

  it("cwdExists 反映目录此刻是否真的存在", () => {
    const gone = join(scratch, "已经删掉的目录");
    const p = makeDb([
      ["alive", scratch, "在", 1_754_000_000_001],
      ["dead", gone, "不在", 1_754_000_000_002],
    ]);
    const byId = new Map(scanOpenCode(p).sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("alive")!.cwdExists).toBe(true);
    expect(byId.get("dead")!.cwdExists).toBe(false);
    // 目录没了也不能把会话丢掉
    expect(byId.get("dead")!.cwd).toBe(gone);
  });

  it("空的 directory 变成 null，而不是空串", () => {
    const p = makeDb([["s", "", "无目录", 1_754_000_000_003]]);
    const s = scanOpenCode(p).sessions[0]!;
    expect(s.cwd).toBeNull();
    expect(s.cwdExists).toBe(false);
  });

  it("空标题不产生 nativeTitle 字段", () => {
    const p = makeDb([["s", scratch, "", 1_754_000_000_004]]);
    expect(scanOpenCode(p).sessions[0]!.nativeTitle).toBeUndefined();
  });

  it("库不存在时返回空列表，不抛错", () => {
    const r = scanOpenCode(join(scratch, "根本没有这个库.db"));
    expect(r.sessions).toEqual([]);
    expect(r.problems).toEqual([]);
  });

  it("扫描不修改库文件（只读）", () => {
    const p = makeDb([["s", scratch, "t", 1_754_000_000_005]]);
    const before = statSync(p).mtimeMs;
    scanOpenCode(p);
    expect(statSync(p).mtimeMs).toBe(before);
  });

  it("本机真实数据：能读出会话且目录都是绝对路径", (ctx) => {
    const real = join(homedir(), ".local", "share", "opencode", "opencode.db");
    if (!existsSync(real)) {
      ctx.skip(); // 本机没装 opencode
      return;
    }
    const r = scanOpenCode(real);
    expect(r.sessions.length).toBeGreaterThan(0);
    for (const s of r.sessions) {
      expect(s.agent).toBe("opencode");
      if (s.cwd !== null) expect(s.cwd).toMatch(/^[A-Za-z]:[\\/]/);
    }
    // OpenCode 的标题实测质量很好，绝大多数会话都该有
    const titled = r.sessions.filter((s) => s.nativeTitle).length;
    expect(titled / r.sessions.length).toBeGreaterThan(0.8);
  });
});
