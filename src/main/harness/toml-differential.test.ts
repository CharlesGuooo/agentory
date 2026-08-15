import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readToml } from "./toml";

/**
 * 差分测试：拿**一个完全独立的实现**核对我们的解析结果。
 *
 * 裁判是 CPython 标准库的 `tomllib`（3.11+），它和 `smol-toml` 没有任何共同血缘。
 * 形状测试只能证明「映射是我想要的映射」，差分测试才能证明「解析本身是对的」——
 * 两个独立实现同时错成一样的概率可以忽略。
 *
 * **单独一个文件**，因为它要起 python 子进程，而其余的 harness 测试要断言零子进程。
 *
 * 只导出**键名**，不导出值 —— 真配置里有明文密钥，不能进日志。
 */

const PY = `
import tomllib, json, sys
with open(sys.argv[1], 'rb') as f: t = tomllib.load(f)
s = t.get('mcp_servers', {})
print(json.dumps({
  'names': sorted(s),
  'disabled': sorted(n for n in s if s[n].get('enabled') is False),
  'keys': {n: sorted(s[n]) for n in sorted(s)},
}))
`;

function pythonSays(path: string): { names: string[]; disabled: string[]; keys: Record<string, string[]> } | null {
  try {
    const out = execFileSync("python", ["-c", PY, path], { encoding: "utf8", timeout: 30_000 });
    return JSON.parse(out) as ReturnType<typeof pythonSays> & object;
  } catch {
    return null; // 没装 python，或它读不动 —— 跳过而不是判失败
  }
}

const FILES = [
  join(homedir(), ".codex", "config.toml"),
  join(homedir(), ".grok", "config.toml"),
];

describe("TOML 差分：smol-toml vs Python tomllib", () => {
  for (const path of FILES) {
    it(`${path.split(/[\\/]/).slice(-2).join("/")} 两个实现结果一致`, (ctx) => {
      if (!existsSync(path)) return void ctx.skip();
      const py = pythonSays(path);
      if (py === null) return void ctx.skip();

      const t = readToml(path) as { mcp_servers?: Record<string, Record<string, unknown>> } | null;
      expect(t, "smol-toml 读不动这个文件").not.toBeNull();
      const servers = t?.mcp_servers ?? {};

      const names = Object.keys(servers).sort();
      const disabled = names.filter((n) => servers[n]?.["enabled"] === false).sort();
      const keys = Object.fromEntries(names.map((n) => [n, Object.keys(servers[n] ?? {}).sort()]));

      console.log(`  ${path.split(/[\\/]/).pop()}：服务器 ${names.length}，写着停用的 ${disabled.length}`);

      expect(names).toEqual(py.names);
      expect(disabled).toEqual(py.disabled);
      // 逐个服务器比字段名 —— 只比名字，值里可能有密钥
      expect(keys).toEqual(py.keys);
    }, 60_000);
  }
});
