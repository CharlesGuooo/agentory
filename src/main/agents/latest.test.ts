import { describe, expect, it } from "vitest";
import { installedVersions } from "./installed";
import { fetchLatest, releasesUrl } from "./latest";
import { isNewer } from "./compare";

describe("从 registry 元数据推「看更新说明」的链接", () => {
  /** 三条都是本机实测抓到的真实返回值。 */
  it("repository.url 里的 git+https 形式", () => {
    expect(releasesUrl({ repository: { url: "git+https://github.com/openai/codex.git" } })).toBe(
      "https://github.com/openai/codex/releases",
    );
  });

  it("homepage 形式（claude 只有这个）", () => {
    expect(releasesUrl({ homepage: "https://github.com/anthropics/claude-code" })).toBe(
      "https://github.com/anthropics/claude-code/releases",
    );
  });

  it("homepage 带 #readme 锚点（codex 的形式）", () => {
    expect(releasesUrl({ homepage: "https://github.com/openai/codex#readme" })).toBe(
      "https://github.com/openai/codex/releases",
    );
  });

  it("git:// 与 shorthand 也认", () => {
    expect(releasesUrl({ repository: "github:earendil-works/pi" })).toBe(
      "https://github.com/earendil-works/pi/releases",
    );
  });

  /**
   * **推不出来就返回 null，绝不写死一个猜的 URL。**
   * opencode 的 registry 里 repository 和 homepage 都没有 —— 实测确认过。
   * 烂掉的链接比没有链接更糟。
   */
  it("两个字段都没有就是 null（opencode 的真实情况）", () => {
    expect(releasesUrl({})).toBeNull();
    expect(releasesUrl({ homepage: "https://opencode.ai" })).toBeNull();
  });
});

/**
 * 真机走网络。**离线就跳过，不 mock** —— mock 出来的成功只能证明我们理解的接口。
 * 这一刀最容易错的恰恰是接口本身：npm registry 对 scoped 包的 `/latest`
 * 在缩略 accept 头下会返回 406，那个坑只有真发一次才撞得到。
 */
describe("真机：查最新版", () => {
  it(
    "五个 agent 的最新版都查得到，并算出谁该升级",
    async (ctx) => {
      const list = installedVersions();
      if (list.length === 0) return void ctx.skip();

      const results = await Promise.all(list.map(async (i) => ({ i, r: await fetchLatest(i) })));

      // 一个都没成功 = 没网，跳过而不是判失败
      if (!results.some((x) => x.r.ok)) return void ctx.skip();

      const rows = results.map(({ i, r }) => {
        const latest = r.ok ? r.version : `查不到（${r.error}）`;
        const flag = r.ok && i.version && isNewer(r.version, i.version) ? "  ← 有新版" : "";
        return `  ${i.agent.padEnd(9)} ${(i.version ?? "?").padEnd(10)} → ${latest.padEnd(24)}${flag}`;
      });
      console.log(`\n${rows.join("\n")}\n`);

      for (const { i, r } of results) {
        if (r.ok) expect(r.version, `${i.agent} 的最新版不像 semver`).toMatch(/^\d+\.\d+/);
      }
    },
    60_000,
  );
});
