## Context

`DESIGN.md` §2 与 §2.6 已经把五个 agent 的存储形态、真实工作目录的取值位置、
transcript 的消息结构全部实测清楚了。本变更是把那些事实变成代码，不需要再调研。

复核（2026-08-13）：claude 487 · opencode 166 · grok 120 · codex 65 · pi 12 = **850 个会话**，
比 8-12 那次多了 3 个 —— **数据在动，这是"每次重扫而不是建索引"的又一条理由**。

## Goals / Non-Goals

**Goals:**
- 五个扫描函数 + 一个合并函数，产出统一形状的会话列表
- 每条记录的工作目录是**真实的**，且标注它此刻是否还存在
- 全量扫描守住 1 秒上限（基线 483 ms）

**Non-Goals:**
- 恢复命令、会话摘要、界面呈现、工作集持久化 —— 各自独立
- 不抽 `AgentAdapter` 接口（D-11）

## Decisions

### D-I1 · 五个具体函数，不建接口

按 D-11：先写 `scanClaude()` / `scanCodex()` / `scanOpenCode()` / `scanPi()` / `scanGrok()`，
各自返回同一个 `Session[]` 形状。**等五个实现都在了再看要不要抽接口。**

理由：接口的形状应由已知实现决定。「一个会话 = 一个文件」这个假设在 Grok 身上直接崩
（它是目录），在 OpenCode 身上也崩（它是数据库行）—— 先写完才知道共同点在哪。

### D-I2 · OpenCode 优先用 Node 内置的 `node:sqlite`，不引入 `better-sqlite3`

Node 22+ 内置 `node:sqlite`，Electron 43 打包的是 Node 24.18。若可用则零依赖，
也就完全避开原生模块编译 —— 而我们已经在 node-pty 上踩过一次那个坑。

**必须先实测确认**（任务 1.1）：在 Electron 43 主进程里 `import { DatabaseSync } from "node:sqlite"`
并以只读方式打开一个带 WAL 的 864 MB 库。

**不通过时的退路**：`better-sqlite3`（原生模块，但同样有 prebuilds）。
**不要**退回去调用 `sqlite3.exe` 子进程 —— 那会把一个外部可执行文件变成运行时依赖。

### D-I3 · 头部流式读，尾部从末尾定位

- **头部**：`createInterface` 逐行读，命中即停。Claude 实测扫前 40 行命中 486/487。
- **尾部**（本次用不到，但接口要留）：`FileHandle.read` 从 `size - N` 开始。
  实测 `Get-Content -Tail` 在 195 MB 的文件上会超时 —— 整文件读是不可接受的。

### D-I4 · 工作目录的存在性用一次 `existsSync` 判定，结果随记录返回

不做缓存。850 次 `existsSync` 在实测里可忽略，而缓存会引入失效问题
（用户随时可能删掉一个项目目录）。

### D-I5 · 扫描是纯函数，存储根目录由参数传入

`scanClaude(root)` 而不是内部硬编码 `~/.claude/projects`。
这样测试可以指向构造好的临时目录，而不必依赖本机恰好装了哪些 agent。

**但同时保留对真实数据的测试** —— 本机 850 个会话是最好的测试夹具，
构造的临时目录测不出「Claude 的第 40 行才出现 cwd」这类真实形态。两种测试都要。

## Risks / Trade-offs

| 风险 | 缓解 |
|---|---|
| ~~`node:sqlite` 在 Electron 43 里不可用~~ | **已验证可用**（Electron 43.4.0 / Node 24.18.1，只读打开 824MB 带 WAL 的库，写入被拒） |
| **`node:sqlite` 在 Node 24 仍标记为实验性**（运行时会打 `ExperimentalWarning`），API 可能变 | 我们只用到 `DatabaseSync` / `prepare` / `all` / `close` 四个点，面很窄；真变了换 `better-sqlite3` 的成本是改一个文件。**权衡后接受** —— 换来的是完全避开原生模块编译（node-pty 那个坑刚踩过） |
| 打开 OpenCode 的库时它正被 opencode 自己写入（有 WAL） | 以只读 URI 打开；已在 PowerShell 侧验证过可行 |
| 依赖本机真实数据的测试在别人机器上跑不了 | 这类测试在对应 agent 未安装时跳过，而不是失败（`resolve.test.ts` 已是这个模式） |
| 1 秒上限在会话数继续增长后被突破 | 上限写进规格就是为了让它被突破时**触发讨论**，而不是悄悄加缓存 |
| Claude 有 1/487 的会话扫不出 cwd | 规格已规定：标记为未知并保留，不丢弃、不用目录名反解凑数 |

## Open Questions

- 会话的「最后活动时间」用文件 mtime 还是内容里的最后一条时间戳？
  mtime 便宜但可能被外部操作改动；内容里的时间戳准确但要读尾部。
  **倾向先用 mtime**，等发现不准再改 —— 但要在实现时对比一次两者的差异并记录。
- Grok 会话的最后活动时间取目录 mtime 还是 `summary.json` 的 `updated_at`？
  后者是 agent 自己写的，更可信，且 `summary.json` 本来就要读。
