import { readFileSync } from "node:fs";
import { parse } from "smol-toml";

/**
 * TOML 读取。**全项目唯一 import `smol-toml` 的地方。**
 *
 * ## 为什么这里破例加了一个依赖
 *
 * 项目一贯选平台能力而非依赖（`node:sqlite` 而不是 better-sqlite3、内置 `fetch` 而不是
 * http 客户端）。但那两次的前提是**平台已经给了** —— 而 Node 没有 TOML，
 * 不像 JSON 有 `JSON.parse`。所以那条先例在这里没有适用条件。
 *
 * 手写一个窄解析器的问题不是写不出来，是**它的错误几乎全是静默的**。
 * 本机配置文件里今天就有两个必错构造（`toml.test.ts` 里逐条钉住了）：
 *
 * - `command = 'C:\Users\...\uvx.exe'` 是**字面串**（`\U` 不转义），
 *   而同文件的 `notify = ["C:\\Users\\..."]` 是**基本串**（要转义）。
 *   一个 `stripQuotes()` 会让前者碰巧对、后者变成双反斜杠 —— 在 Windows 路径上看起来完全正常。
 * - `mcps = false  # 注释` 要去掉值后注释，而 `url = "https://x/y#z"` 里的 `#` 不能切。
 *
 * 而且 codex 的 `config.toml` 是 Rust 的 `toml_edit` **写**的，不是人排的版
 * （证据：`[marketplaces.*]` 的 ISO 时间戳、`[hooks.state.*]` 的 `trusted_hash`）。
 * 一个程序在给我们写输入，它有权发出 TOML 1.0 的任何构造。
 *
 * ## 打包上的代价：零
 *
 * `smol-toml` 放在 **devDependencies**。`electron-vite` 的 `externalizeDepsPlugin`
 * 只 external `dependencies`（`electron-vite/dist/index.js:352`），
 * 所以它被 Rollup 打进 `out/main/index.js` —— **运行时依赖仍然只有 node-pty 一条，
 * 安装包不多一个文件**。它本身零传递依赖、无 postinstall、BSD-3。
 */

/**
 * 读一个 TOML 文件。
 *
 * **读不动一律返回 null，不抛。** 调用方据此显示「读不出来」而不是「没有」——
 * 这两件事在界面上必须能区分（`SourceState` 里 `unreadable` 与 `empty` 是两个值）。
 */
export function readToml(path: string): unknown {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
