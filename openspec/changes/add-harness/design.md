# 设计

## D-H1 · 只统一 key，不统一 record

五套配置唯一真正共有的东西是**标识符** —— MCP 的服务器名、skill 的目录名。
那不是我们发明的抽象，是用户自己敲的、agent 自己用的身份。

所以**矩阵的行是名字**，每个格子里放那个 agent 自己那套字段翻译过来的记录。
造一个「五合一」的配置对象才是假抽象（D-11），而且那个对象会成为秘密进内存的入口。

**不对称本身就是答案**：

| | 做法 | 依据 |
|---|---|---|
| 四个 MCP 读取器 | **四个具体函数** | 两种文件格式、四套字段名，它们真的不一样 |
| skills 读取 | **一个函数 + 五个根路径** | 逻辑**字面上完全相同**（列目录，留下含 `SKILL.md` 的） |
| `McpTarget` | 抽了 | MCP 协议自己定义的 transport，**翻译不是发明** |
| 统一的 `env` 对象 | **没抽** | 那才是假抽象，而且是秘密进内存的入口 |
| pi 的 MCP | 数组里一条 `unsupported` 记录，**不是省略** | 缺席要靠人记住；一条写着「不支持」的记录是代码携带的事实 |

代码一样的地方抽，不一样的地方不抽。让证据决定，不让对称性决定。

## D-H2 · 五种格子状态，每种只有一个意思

一个空格子今天有五种互不相同的含义，**全渲染成空白就是撒谎**：

| 记号 | 含义 |
|---|---|
| `●` | 配置里有 |
| `●●` | **多处定义** —— claude 实测就是（两个文件重叠 7 个） |
| `○` | 配置里**直接写着** `enabled = false` |
| `·` | 配置里没有 |
| `—` | 该 agent **根本不支持**（pi 的 MCP 整列） |
| `?` | **读不出来** —— 绝不当成 0 条 |

`disabledInConfig` 是 `boolean | null` 而不是 `boolean`：**「没说」和「说了开」是两件事**，
各 agent 的缺省语义我们无法校验，把「没说」渲染成「开着」就是在替它们做主。

来源级另有 `off-by-config`：grok 的 `[compat.claude] mcps = false` 表达的不是某条服务器停用，
而是**一整个来源被关掉** —— 它本可以继承 claude 的 9 个，只显示 1 个是因为自己配置里那两行。

## D-H3 · 秘密靠结构挡，不靠纪律

harness 配置是这台机器上密钥密度最高的一类文件。实测：

| | 明文凭证 |
|---|---|
| claude | 2 处 |
| opencode | 3 处 |
| codex / grok | 0（全部走环境变量引用） |

四条机制：

1. **`McpEntry` 有 `envNames: string[]`，没有 `env: Record<string,string>`** ——
   类型上装不下秘密。照 D-W2：「没有可改的东西，就不可能改错」
2. 读取器只 `Object.keys()`，值从不绑定到任何变量
3. `url` 丢掉 query 和 fragment（token 常藏在查询串里，而它对跨 agent 对照零信息量）
4. **零缓存，一个文件都不写** —— 缓存文件是秘密唯一可能被持久化到第二个地方的路径。
   这条被做成了断言（mock `writeFileSync`，断言零次调用）

### 「明文密钥」的判据被实测修正过一次

第一版规则是「任何非占位符字符串值」，跑真机立刻翻车：它把
`env.BLENDER_HOST = "localhost"` 和 14 个 `NODE_REPL_*` 配置值全标成了密钥，
**31 处**里绝大多数是误报。**有值不等于是密钥。**

改成两条同时成立：**字段名像凭证**（`key|token|secret|password|credential|authorization`）
**且**值不是环境变量引用。结果 31 → **11 处，零误报**。

## D-H4 · TOML：加依赖，但不打破单依赖

Node 没有 TOML（不像 JSON 有 `JSON.parse`），所以「选平台能力而非依赖」这条先例
（`node:sqlite`、内置 `fetch`）在这里**没有适用条件**。

**手写窄解析器的错误几乎全是静默的。** 用户机器上今天就有两个必错构造：

- `command = 'C:\Users\...\uvx.exe'` 是**字面串**（`\U` 不转义），而同文件的
  `notify = ["C:\\Users\\..."]` 是**基本串**（要转义）。一个 `stripQuotes()` 会让前者
  碰巧对、后者变成双反斜杠 —— 在 Windows 路径上看起来完全正常
- `mcps = false  # 注释` 要去掉值后注释，而 `url = "https://x/y#z"` 里的 `#` 不能切

而且 codex 的 `config.toml` 是 Rust `toml_edit` **写**的（证据：`[marketplaces.*]` 的
ISO 时间戳、`[hooks.state.*]` 的 `trusted_hash`）—— 一个程序在给我们写输入，
它有权发出 TOML 1.0 的任何构造。

**打包代价：零。** `smol-toml` 放 **devDependencies**，而 `electron-vite` 的
`externalizeDepsPlugin` 只 external `dependencies`（`electron-vite/dist/index.js:352`），
所以它被 Rollup 打进 `out/main/index.js` —— **运行时依赖仍然只有 node-pty 一条**。
它本身零传递依赖、无 postinstall、BSD-3、过 TOML 1.0 一致性测试。

依赖被包在 `harness/toml.ts` 一个文件里，将来换实现只动那一处。

> **D-15「不抓不解析 changelog」被误引在这里。** 那条拒绝的是「没有规范、
> 内容无法校验、随时改版式的自由文本」，三条特征 TOML 一条都不占。
> 这个项目里真正与 changelog 同构的是**另一个东西**：`SKILL.md` 的 YAML frontmatter
> （真文件里 `description:` 用 `>-` 折叠标量跨 9 行）。所以 v1 **不读 frontmatter**。

## D-H5 · 卸载不删文件，丢系统回收站

`shell.trashItem()` —— Electron 自带，一行。用户能自己从资源管理器恢复，
所以**不需要确认弹窗**，也不可能造成不可逆的损失。

这是「绝不替用户销毁记录」（`entryFile.ts` 的既有原则）在这个功能上的形态，
也是「平台能力优先于手搓」的又一次应用（同 `xterm onBell`、`node:sqlite`、`busy_timeout`）。

两道闸，缺一不可（纯函数 `checkUninstall`，有单测）：
1. 必须是真的 skill 目录（含 `SKILL.md`）
2. 必须**正好**位于某个已知 skills 根的下一层

真机验证：回收站里确认存在 `action-first`，原位置 `C:\Users\PC\.grok\skills`。

## 实现时被截图抓出来的三个问题

**冒烟输出全绿不等于界面对。** 这三个都是冒烟看不出、截图一眼就看见的：

1. **两个粘性表头叠在一起。** Skills 和 MCP 的表头都是 `top: 0` 且同属一个滚动容器，
   第二个上来时第一个还钉在那儿，文字糊成一团。修法：每个区块自己一个 `.hx-sec`
   包裹层，让表头的定位上下文各自独立
2. **面板默认落在一个空项目上。** 原本拿当前 tab 的目录当种子，而那个项目没有项目级 skill，
   一打开就是 `0 个 skill · 0 个 MCP`。改成**默认全局，当前 tab 的目录排下拉第一项**
3. **名字列撑满 900px 面板**，名字和格子之间空出一大片，眼睛要横跨过去。整行封顶 760px

另有一个是冒烟抓的：作用域下拉显示的是完整绝对路径 —— `split(/[\/]/)` 少了反斜杠，
Windows 路径根本没被切开。
