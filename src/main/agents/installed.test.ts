import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { changelogUp, installedVersions, packageJsonUp } from "./installed";

/**
 * 记下所有起过的子进程。`vi.mock` 会被提升到文件顶部，所以这个数组必须走 `vi.hoisted`。
 */
const spawned = vi.hoisted(() => [] as string[][]);

vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    execFileSync: (file: string, args?: readonly string[], opts?: unknown) => {
      spawned.push([file, ...(args ?? [])]);
      return (real.execFileSync as (...a: unknown[]) => unknown)(file, args, opts);
    },
  };
});

const scratch = mkdtempSync(join(tmpdir(), "agentory-ver-"));

function tree(name: string, files: Record<string, string>): string {
  const root = join(scratch, name);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

describe("从可执行文件往上找 package.json", () => {
  /** claude / opencode 的形状：`<pkg>/bin/<name>.exe`。 */
  it("跳过没有 package.json 的中间目录", () => {
    const root = tree("a", {
      "node_modules/@scope/thing/package.json": JSON.stringify({
        name: "@scope/thing",
        version: "2.1.220",
      }),
      "node_modules/@scope/thing/bin/thing.exe": "x",
    });
    const hit = packageJsonUp(join(root, "node_modules/@scope/thing/bin/thing.exe"));
    expect(hit).toEqual({ name: "@scope/thing", version: "2.1.220" });
  });

  /** pi 的形状：`<pkg>/dist/cli.js`，中间隔着 dist。 */
  it("dist 下面的脚本也能找到", () => {
    const root = tree("b", {
      "p/package.json": JSON.stringify({ name: "p", version: "0.83.0" }),
      "p/dist/cli.js": "x",
    });
    expect(packageJsonUp(join(root, "p/dist/cli.js"))?.version).toBe("0.83.0");
  });

  /** **最近的那个赢** —— 不能一路走到外层某个不相干的 package.json。 */
  it("取最近的那一个，不是最外层那个", () => {
    const root = tree("c", {
      "package.json": JSON.stringify({ name: "外层", version: "9.9.9" }),
      "node_modules/inner/package.json": JSON.stringify({ name: "inner", version: "1.2.3" }),
      "node_modules/inner/bin/x.exe": "x",
    });
    expect(packageJsonUp(join(root, "node_modules/inner/bin/x.exe"))?.name).toBe("inner");
  });

  it("没有 version 字段的 package.json 不算数，继续往上找", () => {
    const root = tree("d", {
      "p/package.json": JSON.stringify({ name: "有名字没版本" }),
      "q/p/bin/x.exe": "x",
    });
    expect(packageJsonUp(join(root, "q/p/bin/x.exe"))).toBeNull();
  });

  it("坏 JSON 不抛，当成没找到", () => {
    const root = tree("e", { "p/package.json": "{ 这不是 JSON", "p/bin/x.exe": "x" });
    expect(packageJsonUp(join(root, "p/bin/x.exe"))).toBeNull();
  });

  it("一路没有就是 null，不会走到磁盘根", () => {
    const root = tree("f", { "p/bin/x.exe": "x" });
    expect(packageJsonUp(join(root, "p/bin/x.exe"))).toBeNull();
  });
});

describe("从可执行文件往上找 CHANGELOG.md 首行（grok 这类独立二进制）", () => {
  /** grok 本机真实首行：`# 0.2.118 — 2026-07-31` */
  it("认得出 # 版本号 — 日期 这种首行", () => {
    const root = tree("g", {
      "CHANGELOG.md": "# 0.2.118 — 2026-07-31\n\n## Features\n",
      "bin/grok.exe": "x",
    });
    expect(changelogUp(join(root, "bin/grok.exe"))).toBe("0.2.118");
  });

  it("首行不是版本号就不认", () => {
    const root = tree("h", { "CHANGELOG.md": "# Changelog\n", "bin/x.exe": "x" });
    expect(changelogUp(join(root, "bin/x.exe"))).toBeNull();
  });

  it("没有 CHANGELOG.md 就是 null", () => {
    const root = tree("i", { "bin/x.exe": "x" });
    expect(changelogUp(join(root, "bin/x.exe"))).toBeNull();
  });
});

describe("真机：五个 agent 的已装版本", () => {
  /**
   * **这条测试必须证明「一个 agent 子进程都没起」。**
   *
   * 这个项目最贵的一次事故就是探针给 agent 发了输入
   * （`prototype-terminal-fidelity/findings.md:130-137`：`/help`+回车选中了
   * codex 的「立即更新」，把 codex 卸掉重装）。所以这条路径的设计目标不是快，
   * 是**根本不碰 agent 进程**。
   *
   * 原来用「耗时 < 500 ms」当旁证，但那是间接证据，而且在并发套件里量的是调度不是代码
   * （单独跑 280 ms，全套件里 606 ms，翻红过一次）。现在直接记下所有起过的子进程来断言。
   */
  it("装了的都读得出版本，且**没有起过任何 agent 进程**", () => {
    spawned.length = 0;
    const t0 = performance.now();
    const list = installedVersions();
    const ms = performance.now() - t0;

    console.log(
      "\n" +
        list
          .map(
            (i) =>
              `  ${i.agent.padEnd(9)} ${(i.version ?? "版本未知").padEnd(10)} ` +
              `${(i.pkg ?? "非 npm").padEnd(34)} ← ${i.from}`,
          )
          .join("\n") +
        `\n  ${"—".repeat(60)}\n  ${list.length} 个 agent，共 ${ms.toFixed(1)} ms\n`,
    );

    expect(list.length).toBeGreaterThan(0);
    for (const i of list) {
      expect(i.version, `${i.agent} 没读出版本`).not.toBeNull();
      expect(i.version, `${i.agent} 的版本不像 semver`).toMatch(/^\d+\.\d+/);
    }

    // 唯一允许起的进程是 where.exe（`resolveCommand` 用它查 PATH）。
    // **一个 agent 的名字都不许出现在这里。**
    console.log(`  起过的子进程：${spawned.map((c) => c.join(" ")).join(" / ") || "(无)"}`);
    for (const call of spawned) {
      expect(call[0]?.toLowerCase(), `起了不该起的进程：${call.join(" ")}`).toBe("where.exe");
    }
    const AGENTS = ["claude", "codex", "opencode", "pi", "grok"];
    for (const call of spawned) {
      // where.exe 的参数里出现 agent 名是对的（那就是在查 PATH），
      // 但被**执行**的那个文件绝不能是 agent
      expect(AGENTS.some((a) => call[0]?.toLowerCase().includes(a))).toBe(false);
    }
  });
});
