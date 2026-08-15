## ADDED Requirements

### Requirement: 真实工作目录取自会话内容，不反解目录名

系统 SHALL 从会话文件或数据库的内容中读取工作目录，
SHALL NOT 通过反解 agent 的存储目录名来推断路径。

Claude 与 Pi 的目录名是**有损编码**（`\` 和 `_` 都变成 `-`），反解必然得到不存在的路径。
每个 agent 的取值位置见 `DESIGN.md` §2.6。

#### Scenario: 有损目录名不影响结果

- **WHEN** Claude 的存储目录名是 `C--Users-PC-Desktop-Recent-local-GPU`
  而真实路径是 `C:\Users\PC\Desktop\Recent\local_GPU`
- **THEN** 产出的 `cwd` 是带下划线的真实路径
- **AND** 不是把连字符逐个还原成分隔符得到的那个不存在的路径

#### Scenario: 五个 agent 各自的取值位置

- **WHEN** 扫描各 agent 的会话
- **THEN** Claude 取自文件头部若干行中的 `cwd` 字段
- **AND** Codex 取自 `turn_context` 记录的 `payload.cwd`，而非 `session_meta`
- **AND** Pi 取自第一行 header 的 `cwd`
- **AND** Grok 取自会话目录内 `summary.json` 的 `info.cwd`
- **AND** OpenCode 取自 `session` 表的 `directory` 列

#### Scenario: 读不到工作目录的会话

- **WHEN** 某个会话文件中找不到工作目录信息
- **THEN** 该会话仍然出现在结果中，其 `cwd` 标记为未知
- **AND** 不因此丢弃这条会话，也不用目录名反解来凑一个

### Requirement: 子 agent 的 transcript 不是会话

系统 SHALL NOT 把子 agent 的 transcript、工具输出或其它附属文件计入会话列表。

实测：`~/.claude/projects/<编码目录>/` 下除了 `<uuid>.jsonl`（真会话），
还有同名的 `<uuid>/` 附属目录，内含 `subagents/agent-*.jsonl`、`tool-results/`、`workflows/`。
递归扫描会把 74 个真会话数成 459 个。

#### Scenario: 只取顶层会话文件

- **WHEN** 扫描 Claude 的某个项目目录
- **THEN** 只有该目录下直接放着的 `<uuid>.jsonl` 被算作会话
- **AND** 其子目录中的任何文件都不被算作会话

#### Scenario: 侧链标记

- **WHEN** 某个 transcript 的记录中带有表示子 agent 的侧链标记（`isSidechain`）
- **THEN** 它不被算作一个会话

### Requirement: 最后活动时间取自会话内容，不用文件 mtime

系统 SHALL 从会话内容中读取最后一条带时间戳的记录作为「最后活动时间」，
SHALL NOT 使用文件的修改时间。

实测：mtime 恒比内容时间戳新，差异可达 **8 天** ——
因为 agent 会追加不带时间戳的簿记记录（如 Claude 的 `{"type":"last-prompt"}`），
写入更新了 mtime 却不代表用户在此工作过。

#### Scenario: 簿记写入不算活动

- **WHEN** 某会话的文件 mtime 是今天，但内容中最后一条带时间戳的记录在 8 天前
- **THEN** 该会话的最后活动时间是 8 天前
- **AND** 排序时它排在今天真正有过对话的会话之后

#### Scenario: 取不到内容时间戳

- **WHEN** 某会话内容中找不到任何时间戳
- **THEN** 退回使用文件 mtime，并标注该时间为不确定

### Requirement: 标注工作目录当前是否存在

每条会话记录 SHALL 带有一个字段，表明其工作目录此刻是否仍然存在。
系统 SHALL NOT 因为目录已被删除就把会话从结果中剔除。

#### Scenario: 指向已删除目录的会话

- **WHEN** 某个会话的工作目录已被删除（例如临时目录）
- **THEN** 该会话仍出现在结果中，且被标记为工作目录不存在
- **AND** 调用方可据此决定是否展示或是否允许恢复

### Requirement: 绝不整文件读取

系统 SHALL 以流式方式读取会话文件的头部，以从文件末尾定位的方式读取尾部，
SHALL NOT 把整个会话文件读入内存。

实测存在单个 **195 MB** 的会话文件，且 Claude 会话文件平均 10.7 MB（`DESIGN.md` §2.4）。

#### Scenario: 超大会话文件

- **WHEN** 某个会话文件有数百 MB
- **THEN** 扫描它所读取的字节量远小于文件体积
- **AND** 不出现内存暴涨或超时

### Requirement: 会话的存储形态各不相同

系统 SHALL 分别处理三种会话载体：单个文件（Claude / Codex / Pi）、
一个目录（Grok）、数据库中的一行（OpenCode）。

#### Scenario: Grok 的会话是目录

- **WHEN** 扫描 Grok
- **THEN** 每个项目目录下的每个 UUID 子目录算作一个会话
- **AND** 项目目录本身不算作会话

#### Scenario: Codex 按日期分区

- **WHEN** 扫描 Codex
- **THEN** 遍历 `YYYY/MM/DD/` 层级下的会话文件
- **AND** 路径层级不携带任何项目信息，工作目录只能来自文件内容

### Requirement: 可用的原生标题被采纳，不可用的不采纳

当 agent 自带会话标题且质量可用时，系统 SHALL 采纳它，避免重复生成。

#### Scenario: OpenCode 的标题可用

- **WHEN** 扫描 OpenCode
- **THEN** `session.title` 被作为原生标题采纳

#### Scenario: Grok 的 session_summary 不可用

- **WHEN** 扫描 Grok
- **THEN** `summary.json` 的 `session_summary` **不**被作为标题采纳
- **AND** 理由：实测它只是首条消息的粗暴截断（从句子中间切断、带 BOM），见 `DESIGN.md` §2.6

### Requirement: 单条会话损坏不影响整体

系统 SHALL 在单个会话解析失败时跳过它并记录原因，其余会话照常产出。

#### Scenario: 损坏的会话文件

- **WHEN** 某个会话文件内容不是合法 JSONL、或数据库中某行字段缺失
- **THEN** 该会话被跳过并产生一条含文件路径与原因的记录
- **AND** 同一 agent 的其余会话正常返回，扫描不抛出异常

#### Scenario: 某个 agent 未安装

- **WHEN** 某个 agent 的存储目录根本不存在
- **THEN** 该 agent 返回空列表
- **AND** 其余四个 agent 的扫描不受影响

### Requirement: 全量扫描的耗时上限

五个 agent 的全量扫描（含真实工作目录解析）SHALL 在 1 秒内完成。

基线：**437 个会话**（8-13 修正后的真实数，见 `DESIGN.md` §2 的修正块）。
8-12 那次 483 ms 的测量把子 agent transcript 也算进去了，所以是偏保守的基线。
这条上限存在的意义是
**守住「不建索引数据库」这个决定**（D-4）—— 一旦扫描慢到需要缓存，那个决定就要重新讨论。

#### Scenario: 全量扫描

- **WHEN** 对本机全部会话执行一次完整扫描
- **THEN** 耗时在 1 秒以内
- **AND** 结果按最后活动时间倒序排列

### Requirement: 只读

系统 SHALL NOT 向任何 agent 的存储目录或数据库写入、修改或删除任何内容。

#### Scenario: 扫描不留痕迹

- **WHEN** 完成一次全量扫描
- **THEN** 各 agent 存储目录中的文件内容与修改时间均未改变
- **AND** OpenCode 的数据库以只读方式打开
