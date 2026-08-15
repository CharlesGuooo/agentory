## Why

索引层扫出了 437 个会话，但**用户现在还够不着它们** —— 侧栏里只有应用自己起的那一个。

恢复是 `DESIGN.md` §1 的三根支柱之一，也是用户的第一痛点（关机后会话全丢）。
它还必须**排在工作集之前**：工作集最核心的价值是「一键恢复上次那批」，
而没有恢复命令，所谓恢复只能在正确的目录里开一个**空终端**，对话历史回不来 —— 那是半个功能。

`docs/research-notes.md §8` 给了一条不含糊的验收标准：
**「对 Codex 生成的是 `codex resume <id>` 而不是 `codex --resume <id>`」**。

## What Changes

- 五个 agent 各自的**恢复命令生成**（纯函数）：`resumeCommand(session) → { command, args }`
- 一个**历史会话视图**：437 条可搜索、可按 agent 与文件夹筛选，点一条即在新标签页恢复
- 恢复一律在会话的**真实 cwd** 下启动；cwd 已消失的会话（实测 35 个）不允许恢复

**⚠ 本次修正 `docs/research-notes.md §3.3` 两处会静默毁掉功能的记载**（8-13 实测）：

| agent | README 记的 | 实际 |
|---|---|---|
| **grok** | `--session-id <id>` | **错**。`-r, --resume <id>` 才是恢复 |
| **pi** | `--session <path\|id>` | 对。但 `--session-id <id>` 文档写着 **"creating it if missing"** |

这两个 `--session-id` 是陷阱：拿它去恢复，id 若对不上**不会报错**，
而是静默开一个**新的空会话** —— 用户以为历史回来了，实际什么都没有。

**不在本次范围**：
- **工作集与持久化**（D-5 / D-6）—— 下一刀
- **批量恢复**（D-12）—— 依赖工作集
- **会话摘要**（D-7）
- 侧栏仍然只显示应用起的会话，**不显示那 437 条**（D-8：默认从 0 开始）

## Capabilities

### New Capabilities
- `session-resume`: 由一条索引记录生成正确的恢复命令，并在其真实工作目录下拉起

### Modified Capabilities
- `app-shell`: 新增历史会话视图 —— 侧栏之外的一个独立列表，可搜索筛选，从中恢复

## Impact

- 无新增依赖
- 新增 `src/main/sessions/resume.ts`（纯函数，严格 TDD）
- `terminal-host` 的 `spawn` 已支持 `args`，不需要改
- 渲染层新增历史视图；侧栏内容与默认行为**不变**
