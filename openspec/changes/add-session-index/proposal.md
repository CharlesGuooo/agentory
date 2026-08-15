## Why

应用现在能跑终端、能换肤，但**完全不知道机器上那 850 个会话的存在**。

`DESIGN.md` §1 把三个支柱排成：重启恢复 → 会话摘要 → 跨 agent 切换。
后两个都建立在同一个前提上 —— **先能把五个 agent 的会话列出来**。没有索引，
恢复不知道恢复什么，摘要不知道摘要谁。

这也是产品**唯一没被别人做掉的部分**。`doctly/switchboard` 在 Windows 上做了同样的形态，
但只支持 Claude 一个 agent；`jazzyalex/agent-sessions` 支持十个 agent 但只有 macOS。
**跨 agent + Windows** 这个交集，索引层就是它的全部内容。

规格材料早已备齐并实测过：`DESIGN.md` §2（五种存储形态）、§2.6（transcript 结构与
真实 cwd 的来源）、以及那张「五个 agent 通用的首条消息注入」过滤表。

## What Changes

- 为五个 agent 各写一个**扫描函数**，产出统一形状的会话记录：
  `{ agent, sessionId, cwd, cwdExists, lastActivity, nativeTitle? }`
- **真实 cwd 一律从会话内容里取**，绝不反解目录名 ——
  Claude 与 Pi 的目录名是有损编码（`local_GPU` → `local-GPU`），反解会得到不存在的路径
- 每条会话标注 **cwd 当前是否存在**，而不是把指向已删目录的会话静默丢掉
- 一个合并函数把五份结果并成一张按最后活动时间排序的表
- **不建索引数据库**（D-4）：全量扫描实测 483ms，每次重扫比维护索引简单一个数量级

**不在本次范围**：
- **恢复命令**（`claude --resume <id>` 等）—— 独立能力，`terminal-host` 的 `spawn` 已支持 `args`
- **会话摘要**（D-7）—— 需要 DeepSeek 与缓存，独立变更
- **界面**：索引结果如何在侧栏/搜索里呈现 —— 独立变更
- **工作集持久化与批量恢复**（D-5 / D-6 / D-12）

## Capabilities

### New Capabilities
- `session-index`: 扫描五个 agent 各自的存储，产出统一的会话列表 ——
  含真实工作目录、最后活动时间、以及可用的原生标题

### Modified Capabilities
（无）

## Impact

- **可能新增零依赖**：OpenCode 是 SQLite。Node 22+ 内置 `node:sqlite`，
  Electron 43 打包的是 Node 24.18 —— 若可用则**不引入 `better-sqlite3`**，
  也就不再有原生模块编译的问题。需实测确认（见 design.md）
- 新增 `src/main/index/`，五个扫描器 + 一个合并函数
- 不影响现有的 `terminal-host` 与 `theme-system`
- **只读**：绝不写入任何 agent 的存储目录
