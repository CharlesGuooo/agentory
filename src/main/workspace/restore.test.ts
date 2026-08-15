import { describe, expect, it } from "vitest";
import type { WorkspaceEntry } from "./model";
import { restoreSerially } from "./restore";

const e = (id: string): WorkspaceEntry => ({
  agent: "claude",
  sessionId: id,
  cwd: "C:\\x",
  addedAt: "2026-08-13T10:00:00.000Z",
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("restoreSerially", () => {
  it("一次只起一个 —— 任何两次启动都不重叠", async () => {
    // 实测负载：8 个 claude ≈ 上百个子进程。并行恢复会瞬间打满机器。
    let inFlight = 0;
    let maxInFlight = 0;
    await restoreSerially(
      [e("a"), e("b"), e("c")],
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(20);
        inFlight -= 1;
      },
      () => {},
    );
    expect(maxInFlight).toBe(1);
  });

  it("按给定顺序启动", async () => {
    const order: Array<string | null> = [];
    await restoreSerially(
      [e("a"), e("b"), e("c")],
      async (x) => {
        await sleep(5);
        order.push(x.sessionId);
      },
      () => {},
    );
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("进度按 已完成/总数 递进", async () => {
    const seen: Array<[number, number]> = [];
    await restoreSerially([e("a"), e("b")], async () => {}, (done, total) => seen.push([done, total]));
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("其中一个失败不中断其余", async () => {
    const started: Array<string | null> = [];
    const out = await restoreSerially(
      [e("a"), e("坏的"), e("c")],
      async (x) => {
        started.push(x.sessionId);
        if (x.sessionId === "坏的") throw new Error("工作目录已不存在");
      },
      () => {},
    );
    // 后面的照常启动
    expect(started).toEqual(["a", "坏的", "c"]);
    expect(out.filter((r) => r.ok).map((r) => r.entry.sessionId)).toEqual(["a", "c"]);
  });

  it("结束后能说出哪几个失败、为什么", async () => {
    const out = await restoreSerially(
      [e("a"), e("坏的")],
      async (x) => {
        if (x.sessionId === "坏的") throw new Error("工作目录已不存在：C:/gone");
      },
      () => {},
    );
    const bad = out.find((r) => !r.ok)!;
    expect(bad.entry.sessionId).toBe("坏的");
    expect(bad.error).toContain("工作目录已不存在");
  });

  it("失败也计入进度 —— 进度反映的是处理完的个数", async () => {
    const seen: number[] = [];
    await restoreSerially(
      [e("a"), e("坏的")],
      async (x) => {
        if (x.sessionId === "坏的") throw new Error("x");
      },
      (done) => seen.push(done),
    );
    expect(seen).toEqual([1, 2]);
  });

  it("空列表直接返回，不调用进度", async () => {
    let calls = 0;
    const out = await restoreSerially([], async () => {}, () => (calls += 1));
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
