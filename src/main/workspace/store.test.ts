import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addEntry, emptyWorkspace, type WorkspaceEntry } from "./model";
import { loadWorkspace, saveWorkspace } from "./store";

const scratch = mkdtempSync(join(tmpdir(), "agentory-ws-"));
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 残留无害 */
  }
});

let n = 0;
const file = (): string => join(scratch, `ws-${n++}.json`);

const e = (id: string): WorkspaceEntry => ({
  agent: "claude",
  sessionId: id,
  cwd: "C:\\proj",
  addedAt: "2026-08-13T10:00:00.000Z",
});

describe("工作集持久化", () => {
  it("写入后读回一致", () => {
    const p = file();
    let ws = addEntry(emptyWorkspace(), e("s1"));
    ws = addEntry(ws, { ...e("s2"), agent: "pi" });
    saveWorkspace(p, ws);

    const r = loadWorkspace(p);
    expect(r.warnings).toEqual([]);
    expect(r.workspace.sessions).toEqual(ws.sessions);
  });

  it("文件不存在时返回空工作集，且不算错误", () => {
    const r = loadWorkspace(join(scratch, "从来没写过.json"));
    expect(r.workspace.sessions).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("坏 JSON → 空工作集 + 告警，且**不覆盖原文件**", () => {
    const p = file();
    const raw = "{ 这不是 JSON";
    writeFileSync(p, raw);

    const r = loadWorkspace(p);
    expect(r.workspace.sessions).toEqual([]);
    // 断内容不断条数：坏读还会多带一条「原文件已备份到 …」（见 entryFile.test.ts）
    expect(r.warnings.some((w) => w.includes("不是合法 JSON"))).toBe(true);
    // 用户的文件可能是手改坏的，读失败不该顺手把它抹了
    expect(readFileSync(p, "utf8")).toBe(raw);
  });

  it("顶层结构不对 → 空工作集 + 告警", () => {
    const p = file();
    writeFileSync(p, JSON.stringify({ nope: true }));
    const r = loadWorkspace(p);
    expect(r.workspace.sessions).toEqual([]);
    expect(r.warnings.some((w) => w.includes("缺少 sessions 数组"))).toBe(true);
  });

  it("个别条目缺字段时只跳过它，其余照常读回", () => {
    const p = file();
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        sessions: [e("好的"), { agent: "claude" }, { sessionId: "没有 agent", cwd: "C:\\x" }],
      }),
    );
    const r = loadWorkspace(p);
    expect(r.workspace.sessions.map((x) => x.sessionId)).toEqual(["好的"]);
    expect(r.warnings.filter((w) => w.startsWith("跳过条目"))).toHaveLength(2);
  });

  it("未知的 agent 名被跳过", () => {
    const p = file();
    writeFileSync(
      p,
      JSON.stringify({ version: 1, sessions: [{ ...e("x"), agent: "根本不存在的 agent" }] }),
    );
    const r = loadWorkspace(p);
    expect(r.workspace.sessions).toEqual([]);
    expect(r.warnings[0]).toContain("根本不存在的 agent");
  });

  it("目标目录不存在时 save 会自己建出来", () => {
    const p = join(scratch, "还没有的目录", "ws.json");
    saveWorkspace(p, addEntry(emptyWorkspace(), e("s1")));
    expect(loadWorkspace(p).workspace.sessions).toHaveLength(1);
  });

  it("落盘的是可读的 JSON —— 用户能手改", () => {
    const p = file();
    saveWorkspace(p, addEntry(emptyWorkspace(), e("s1")));
    const raw = readFileSync(p, "utf8");
    expect(raw).toContain("\n"); // 有缩进，不是压成一行
    expect(JSON.parse(raw).sessions[0].sessionId).toBe("s1");
  });
});
