import { describe, expect, it } from "vitest";
import { inlineSecretPaths, keysOf, safeUrl, stringsOf } from "./fields";

const SECRET = "Bearer TOP-SECRET-42";

describe("只取键名，值绝不出来", () => {
  /**
   * **正反各一条。**
   *
   * 只断言「不含密钥」是不够的 —— 一个什么都不读的实现也能通过。
   * 必须同时断言「确实读到了键名」，才能证明我们是**读了但没带值**，
   * 而不是碰巧啥都没读。
   */
  it("读得到键名（正）", () => {
    expect(keysOf({ Authorization: SECRET, "X-Key": "abc" })).toEqual(["Authorization", "X-Key"]);
  });

  it("返回值里不含任何密钥（反）", () => {
    const out = keysOf({ Authorization: SECRET });
    expect(JSON.stringify(out)).not.toContain("TOP-SECRET-42");
    expect(JSON.stringify(out)).not.toContain("Bearer");
  });

  it("不是对象就是空数组，不抛", () => {
    for (const v of [null, undefined, "字符串", 42, ["a"]]) expect(keysOf(v)).toEqual([]);
  });
});

describe("明文密钥的判定", () => {
  /** opencode 用 `{env:VAR}`，claude 用 `$VAR`。这两种是引用，不是明文。 */
  it("占位符不算明文", () => {
    expect(inlineSecretPaths("environment", { A: "{env:BRAVE_API_KEY}" })).toEqual([]);
    expect(inlineSecretPaths("env", { B: "$GITHUB_TOKEN" })).toEqual([]);
    expect(inlineSecretPaths("env", { C: "${GITHUB_TOKEN}" })).toEqual([]);
  });

  /** 实测：claude 的 github.headers.Authorization 与 opencode 的三处都是这种。 */
  it("凭证字段的字面值算明文，且只返回路径不返回值", () => {
    const out = inlineSecretPaths("headers", { Authorization: SECRET, Accept: "application/json" });
    // Accept 不是凭证字段 —— 它有明文值是理所当然的
    expect(out).toEqual(["headers.Authorization"]);
    expect(JSON.stringify(out)).not.toContain("TOP-SECRET-42");
  });

  /**
   * **有值不等于是密钥。**
   * 实测第一版规则（任何非占位符字符串）把 `env.BLENDER_HOST = "localhost"`
   * 和 14 个 `NODE_REPL_*` 配置值全标成了密钥。
   */
  it("普通配置值不算 —— 字段名不像凭证就不标", () => {
    expect(
      inlineSecretPaths("env", {
        BLENDER_HOST: "localhost",
        BLENDER_PORT: "9876",
        DISABLE_TELEMETRY: "false",
        NODE_REPL_NODE_PATH: String.raw`C:\x\y`,
      }),
    ).toEqual([]);
  });

  it("认得出各种凭证字段名", () => {
    const out = inlineSecretPaths("env", {
      BRAVE_API_KEY: "abc123",
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x",
      MY_SECRET: "s",
      DB_PASSWORD: "p",
    });
    expect(out.sort()).toEqual([
      "env.BRAVE_API_KEY",
      "env.DB_PASSWORD",
      "env.GITHUB_PERSONAL_ACCESS_TOKEN",
      "env.MY_SECRET",
    ]);
  });

  it("空串不算 —— 那是没配，不是泄漏", () => {
    expect(inlineSecretPaths("env", { A: "" })).toEqual([]);
  });

  it("非字符串值不算（数字、布尔、嵌套对象）", () => {
    expect(inlineSecretPaths("env", { A: 1, B: true, C: { D: SECRET } })).toEqual([]);
  });
});

describe("URL 去掉 query 和 fragment", () => {
  /** token 常藏在查询串里，而查询串对跨 agent 对照零信息量 —— 丢掉是免费的。 */
  it("扔掉 ?key=…", () => {
    expect(safeUrl("https://mcp.example.com/sse?key=SUPERSECRET")).toBe(
      "https://mcp.example.com/sse",
    );
  });

  it("扔掉 #fragment", () => {
    expect(safeUrl("https://x.dev/y#z")).toBe("https://x.dev/y");
  });

  it("保留 origin 和 path —— 那才是用来对照的东西", () => {
    expect(safeUrl("https://api.githubcopilot.com/mcp")).toBe("https://api.githubcopilot.com/mcp");
  });

  it("不是 URL 就原样返回，不抛", () => {
    expect(safeUrl("这不是 URL")).toBe("这不是 URL");
  });
});

describe("字符串数组", () => {
  it("codex 的 env_vars = [\"A\",\"B\"]", () => {
    expect(stringsOf(["A", "B"])).toEqual(["A", "B"]);
  });

  it("混进非字符串就滤掉", () => {
    expect(stringsOf(["A", 1, null, "B"])).toEqual(["A", "B"]);
  });

  it("不是数组就是空", () => {
    expect(stringsOf("A")).toEqual([]);
  });
});
