## ADDED Requirements

### Requirement: 每个 agent 的恢复命令各不相同

系统 SHALL 按 agent 生成对应的恢复命令。五套命令实测于 2026-08-13：

| agent | 恢复指定会话 |
|---|---|
| claude | `claude --resume <id>` |
| **codex** | **`codex resume <id>`**（子命令，不是 flag） |
| opencode | `opencode --session <id>` |
| pi | `pi --session <id>` |
| grok | `grok --resume <id>` |

#### Scenario: Codex 是唯一用子命令的

- **WHEN** 为一条 codex 会话生成恢复命令
- **THEN** 得到的是 `codex resume <id>`
- **AND** **不是** `codex --resume <id>`

这是 `docs/research-notes.md §8` 定下的验收标准。

#### Scenario: 其余四个用 flag

- **WHEN** 为 claude / opencode / pi / grok 生成恢复命令
- **THEN** 会话 id 作为对应 flag 的值传入，而不是作为子命令

### Requirement: 绝不使用「不存在就创建」的参数

系统 SHALL NOT 使用任何在会话不存在时会**静默新建**会话的参数。

实测：`pi --session-id <id>` 与 `grok --session-id <id>` 的文档均写明
「creating it if missing」/「optionally set via」。用它们恢复时，
id 若对不上**不报错**，而是开一个新的空会话 —— 用户以为历史回来了，实际什么都没有。
这类静默失败比报错危险得多。

#### Scenario: pi 用 --session 而非 --session-id

- **WHEN** 为 pi 会话生成恢复命令
- **THEN** 用的是 `--session`
- **AND** 不出现 `--session-id`

#### Scenario: grok 用 --resume 而非 --session-id

- **WHEN** 为 grok 会话生成恢复命令
- **THEN** 用的是 `--resume`
- **AND** 不出现 `--session-id`

### Requirement: 恢复必须在会话的真实工作目录下进行

系统 SHALL 在会话记录的 `cwd` 下启动恢复命令。

agent 的会话是按目录划分的 —— 在错误的目录下恢复，轻则找不到会话，
重则在别的项目里开出一个新会话。

#### Scenario: 在原目录恢复

- **WHEN** 恢复一条 `cwd` 为 `C:\Users\PC\Desktop\Recent\local_GPU` 的会话
- **THEN** 子进程的工作目录就是该路径

#### Scenario: 工作目录已消失的会话不可恢复

- **WHEN** 某条会话的 `cwdExists` 为 false（实测本机有 35 条）
- **THEN** 系统拒绝恢复，并给出指明该路径已不存在的错误
- **AND** 不退回到用别的目录去恢复

#### Scenario: 工作目录未知的会话不可恢复

- **WHEN** 某条会话的 `cwd` 为 null
- **THEN** 系统拒绝恢复，并说明原因

### Requirement: 恢复用的命令名要解析成真实可执行文件

系统 SHALL 复用 `terminal-host` 已有的命令解析，把 `claude` / `codex` 等名字
解析成真正的可执行文件。

Windows 的 `CreateProcess` 跑不了 `.cmd`，而这些 agent 在 PATH 里多是 npm 的 shim。

#### Scenario: 通过 shim 的 agent 也能恢复

- **WHEN** 恢复一条 codex 会话（其 PATH 入口是 `codex.cmd`）
- **THEN** 实际启动的是 shim 指向的可执行文件，参数为 `resume <id>`

### Requirement: 历史会话可搜索与筛选

系统 SHALL 提供对全部已索引会话的检索：按文本匹配、按 agent 筛选、按工作目录筛选。

#### Scenario: 文本匹配覆盖目录与标题

- **WHEN** 用户输入一段文本
- **THEN** 工作目录或原生标题包含该文本的会话被保留
- **AND** 匹配忽略大小写

#### Scenario: 按 agent 筛选

- **WHEN** 用户只选了某几个 agent
- **THEN** 只有这些 agent 的会话被保留

#### Scenario: 筛选不改变排序

- **WHEN** 任意筛选被施加
- **THEN** 结果仍按最后活动时间倒序

#### Scenario: 无匹配时给出明确结果

- **WHEN** 没有会话满足条件
- **THEN** 返回空列表，且界面明确说明「没有匹配」，而不是显示成加载中或空白
