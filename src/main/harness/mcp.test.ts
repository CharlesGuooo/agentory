import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeMcpSources, readCodexMcp, readGrokMcp, readOpenCodeMcp } from "./mcp";

const scratch = mkdtempSync(join(tmpdir(), "agentory-mcp-"));
let n = 0;
const file = (name: string, body: string): string => {
  const p = join(scratch, `${n++}-${name}`);
  writeFileSync(p, body);
  return p;
};

const SECRET = "Bearer TOP-SECRET-42";

describe("codex（TOML）", () => {
  /** 对应 ~/.codex/config.toml:54 的字面串 command。 */
  it("stdio：command + args 合成 argv", () => {
    const p = file(
      "codex.toml",
      ['[mcp_servers.brave-search]', 'command = "npx"', 'args = ["-y", "@brave/brave-search-mcp-server@2.0.80"]'].join("\n"),
    );
    const e = readCodexMcp(p).entries[0]!;
    expect(e.name).toBe("brave-search");
    expect(e.target).toEqual({
      kind: "stdio",
      argv: ["npx", "-y", "@brave/brave-search-mcp-server@2.0.80"],
    });
  });

  /** codex 的 env_vars 只写变量名，本来就没有值可泄漏。 */
  it("env_vars 与 bearer_token_env_var 都算环境变量名", () => {
    const p = file(
      "codex2.toml",
      [
        "[mcp_servers.a]",
        'command = "x"',
        'env_vars = ["BRAVE_API_KEY"]',
        "[mcp_servers.b]",
        'url = "https://api.githubcopilot.com/mcp"',
        'bearer_token_env_var = "GITHUB_PERSONAL_ACCESS_TOKEN"',
      ].join("\n"),
    );
    const r = readCodexMcp(p);
    expect(r.entries.find((e) => e.name === "a")?.envNames).toEqual(["BRAVE_API_KEY"]);
    expect(r.entries.find((e) => e.name === "b")?.envNames).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(r.entries.find((e) => e.name === "b")?.target).toEqual({
      kind: "http",
      url: "https://api.githubcopilot.com/mcp",
    });
  });

  /** 「没说」和「说了开」是两件事。 */
  it("enabled=false 是 true，没写是 null，写了 true 是 false", () => {
    const p = file(
      "codex3.toml",
      ["[mcp_servers.off]", 'command = "x"', "enabled = false",
       "[mcp_servers.no]", 'command = "x"',
       "[mcp_servers.on]", 'command = "x"', "enabled = true"].join("\n"),
    );
    const by = Object.fromEntries(readCodexMcp(p).entries.map((e) => [e.name, e.disabledInConfig]));
    expect(by).toEqual({ off: true, no: null, on: false });
  });

  it("子表形式的 env 也能取到键名", () => {
    const p = file(
      "codex4.toml",
      ["[mcp_servers.blender]", 'command = "uvx"', "[mcp_servers.blender.env]", 'BLENDER_HOST = "localhost"'].join("\n"),
    );
    expect(readCodexMcp(p).entries[0]?.envNames).toEqual(["BLENDER_HOST"]);
  });

  it("文件不存在是 missing；解析失败是 unreadable，不是 empty", () => {
    expect(readCodexMcp(join(scratch, "没有.toml")).state).toBe("missing");
    expect(readCodexMcp(file("bad.toml", "[[[坏的")).state).toBe("unreadable");
  });
});

describe("opencode（JSON，字段名和别家都不一样）", () => {
  /** 键是 "mcp" 不是 "mcpServers"；command 是数组；环境变量字段叫 environment。 */
  it("command 数组直接就是 argv", () => {
    const p = file(
      "oc.json",
      JSON.stringify({
        mcp: {
          github: {
            type: "local",
            command: ["npx", "-y", "@modelcontextprotocol/server-github"],
            environment: { GITHUB_PERSONAL_ACCESS_TOKEN: "{env:GITHUB_PERSONAL_ACCESS_TOKEN}" },
          },
        },
      }),
    );
    const e = readOpenCodeMcp(p).entries[0]!;
    expect(e.target).toEqual({
      kind: "stdio",
      argv: ["npx", "-y", "@modelcontextprotocol/server-github"],
    });
    expect(e.envNames).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    // 占位符不算明文
    expect(e.inlineSecrets).toEqual([]);
  });

  it("remote + headers", () => {
    const p = file(
      "oc2.json",
      JSON.stringify({
        mcp: { web: { type: "remote", url: "https://r.example.com/mcp", headers: { Authorization: SECRET } } },
      }),
    );
    const e = readOpenCodeMcp(p).entries[0]!;
    expect(e.target).toEqual({ kind: "http", url: "https://r.example.com/mcp" });
    expect(e.headerNames).toEqual(["Authorization"]);
    expect(e.inlineSecrets).toEqual(["headers.Authorization"]);
  });
});

describe("claude（两个来源）", () => {
  it("两个来源都返回，顺序固定：.claude.json 在前", () => {
    const got = claudeMcpSources();
    expect(got.length).toBe(2);
    expect(got[0]?.path).toMatch(/\.claude\.json$/);
    expect(got[1]?.path).toMatch(/settings\.json$/);
  });
});

describe("grok：来源级开关", () => {
  it("[compat.claude] mcps = false 记成一句话", () => {
    const p = file(
      "grok.toml",
      ["[compat.claude]", "mcps = false", "", "[mcp_servers.brave-search]", 'command = "cmd"', 'args = ["/c", "npx"]'].join("\n"),
    );
    const r = readGrokMcp(p);
    expect(r.entries.map((e) => e.name)).toEqual(["brave-search"]);
    expect(r.note).toContain("[compat.claude] mcps = false");
  });

  it("没关就没有那句话", () => {
    const p = file("grok2.toml", ['[mcp_servers.a]', 'command = "x"'].join("\n"));
    expect(readGrokMcp(p).note).toBeNull();
  });
});

describe("秘密不外泄：正反各一条", () => {
  /**
   * 只断言「不含密钥」是不够的 —— 一个什么都不读的实现也能通过。
   * 所以同时断言「确实读到了键名」，证明我们是**读了但没带值**。
   */
  it("密钥值不进结果，但键名进了", () => {
    const p = file(
      "secret.json",
      JSON.stringify({
        mcp: {
          s: {
            type: "remote",
            url: "https://x.dev/mcp?token=ALSO-SECRET",
            headers: { Authorization: SECRET },
            environment: { KEY: "PLAINTEXT-KEY-99" },
          },
        },
      }),
    );
    const r = readOpenCodeMcp(p);
    const dumped = JSON.stringify(r);

    // 反：一个字都不能出现
    expect(dumped).not.toContain("TOP-SECRET-42");
    expect(dumped).not.toContain("PLAINTEXT-KEY-99");
    expect(dumped).not.toContain("ALSO-SECRET"); // URL 的查询串也要没了

    // 正：确实读到了，不是碰巧啥都没读
    const e = r.entries[0]!;
    expect(e.headerNames).toEqual(["Authorization"]);
    expect(e.envNames).toEqual(["KEY"]);
    expect(e.inlineSecrets.sort()).toEqual(["environment.KEY", "headers.Authorization"]);
    expect(e.target).toEqual({ kind: "http", url: "https://x.dev/mcp" });
  });
});
