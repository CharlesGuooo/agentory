import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readToml } from "./toml";

const scratch = mkdtempSync(join(tmpdir(), "agentory-toml-"));
let n = 0;
/** 写一个临时 TOML 再读回来。 */
const parse = (body: string): unknown => {
  const p = join(scratch, `t${n++}.toml`);
  writeFileSync(p, body);
  return readToml(p);
};

/**
 * ## 这一组测试存在的理由
 *
 * 这里的每一条都对应**本机配置文件里今天就有的一个构造**，而且都是
 * 「手写解析器会静默弄错、但看起来对」的那一类。它们是选依赖而不是手写的论据本身，
 * 也是将来万一要换实现时的验收标准。
 */
describe("TOML：手写解析器会静默弄错的那些", () => {
  /**
   * **最要命的一条。**
   * `~/.codex/config.toml` 里 `command = 'C:\Users\PC\...\uvx.exe'` 是**字面串**，
   * 单引号里的反斜杠不转义；而同一个文件里 `notify = ["C:\\Users\\..."]` 是**基本串**，
   * 反斜杠要转义。一个 `stripQuotes()` 会让前者碰巧对、后者变成双反斜杠 ——
   * 而在 Windows 路径上，双反斜杠看起来「就是转义嘛」，没人会觉得不对。
   */
  it("字面串不转义：'C:\\Users\\new' 里的 \\n 是两个字符，不是换行", () => {
    const t = parse(String.raw`p = 'C:\Users\new\test'`) as { p: string };
    expect(t.p).toBe("C:\\Users\\new\\test");
    // 说清楚要防的是什么：`\n` 必须还是「反斜杠 + n」两个字符，不是一个换行
    expect(t.p).not.toContain("\n");
  });

  it("基本串要转义：\"C:\\\\Users\\\\PC\" 出来是单反斜杠", () => {
    const t = parse(String.raw`p = "C:\\Users\\PC"`) as { p: string };
    expect(t.p).toBe("C:\\Users\\PC");
  });

  /**
   * `~/.grok/config.toml:99` 是 `mcps = false    # MCP 只走本文件的…`，
   * 所以值后注释必须处理。但 `line.split("#")[0]` 会把 URL 里的 fragment 也切掉。
   */
  it("值后注释要去掉，但字符串里的 # 不能动", () => {
    const t = parse(
      ['a = false    # 这是注释', 'u = "https://x.dev/y#z"   # 这才是注释'].join("\n"),
    ) as { a: boolean; u: string };
    expect(t.a).toBe(false);
    expect(t.u).toBe("https://x.dev/y#z");
  });

  /**
   * `~/.codex/config.toml:278` 有 `[hooks.state.'C:\Users\PC\.codex\hooks.json:session_start:0:0']`。
   * 对表头做 `split(".")` 会切出一堆垃圾段。这里验的是同一个机制用在 mcp_servers 上的后果。
   */
  it("表名里带点号的引号段是一个整体，不是两个", () => {
    const t = parse('[mcp_servers."has.dot"]\ncommand = "x"') as {
      mcp_servers: Record<string, unknown>;
    };
    expect(Object.keys(t.mcp_servers)).toEqual(["has.dot"]);
  });

  /** 畸形/复杂表头不能把后面的内容带崩 —— 真文件里 projects 段就在 mcp_servers 前后。 */
  it("带反斜杠路径的表头之后，mcp_servers 仍然找得到", () => {
    const t = parse(
      [
        String.raw`[projects.'C:\Users\PC\.codex\hooks.json:session_start:0:0']`,
        "trusted = true",
        "",
        "[mcp_servers.after]",
        'command = "npx"',
      ].join("\n"),
    ) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(t.mcp_servers)).toEqual(["after"]);
  });

  /** grok 的 env 是内联表；codex 用的是 [x.env] 子表。两种都要认。 */
  it("内联表和子表都能读出键名", () => {
    const inline = parse('[mcp_servers.a]\nenv = { A = "1", B = "2" }') as {
      mcp_servers: { a: { env: Record<string, string> } };
    };
    expect(Object.keys(inline.mcp_servers.a.env)).toEqual(["A", "B"]);

    const sub = parse('[mcp_servers.b]\ncommand = "x"\n[mcp_servers.b.env]\nC = "3"') as {
      mcp_servers: { b: { env: Record<string, string> } };
    };
    expect(Object.keys(sub.mcp_servers.b.env)).toEqual(["C"]);
  });

  /** toml_edit 换行长值时会产生多行数组。今天没有，但随时会有。 */
  it("多行数组要完整读出来", () => {
    const t = parse(['a = [', '  "one",', '  "two",', "]"].join("\n")) as { a: string[] };
    expect(t.a).toEqual(["one", "two"]);
  });

  /** codex 有 4 处 [[hooks.PreToolUse]]。我们不读它，但不能被它带崩。 */
  it("数组表不影响后面的普通表", () => {
    const t = parse(
      ["[[hooks.PreToolUse]]", 'command = "x"', "", "[mcp_servers.z]", 'command = "y"'].join("\n"),
    ) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(t.mcp_servers)).toEqual(["z"]);
  });

  /** `startup_timeout_sec = 30.0`（机器写的）与 `= 60`（人写的）并存。 */
  it("整数和浮点都当数字", () => {
    const t = parse("a = 30.0\nb = 60") as { a: number; b: number };
    expect(t.a).toBe(30);
    expect(t.b).toBe(60);
  });
});

describe("读不动的时候", () => {
  /** 「不猜」：读不出来必须是 null，让调用方能把它显示成「读不出来」而不是「没有」。 */
  it("文件不存在返回 null，不抛", () => {
    expect(readToml(join(scratch, "根本不存在.toml"))).toBeNull();
  });

  it("语法错返回 null，不抛", () => {
    expect(parse("[[[这不是 TOML")).toBeNull();
  });
});
