## ADDED Requirements

### Requirement: 在伪终端中启动 agent 进程

系统 SHALL 在指定的工作目录下，通过 ConPTY 支撑的伪终端启动一个 agent 命令，
并将该伪终端与一个 xterm.js 实例绑定。

#### Scenario: 在指定目录启动 claude

- **WHEN** 请求在 `C:\Users\PC\Desktop\Recent\multi_agents_desktop_app` 启动 `claude`
- **THEN** 进程在该目录下启动，其 `cwd` 与请求一致
- **AND** xterm.js 中出现 Claude Code 的交互界面

#### Scenario: 工作目录不存在

- **WHEN** 请求的工作目录不存在
- **THEN** 系统不启动进程，并返回一个指明该路径不存在的错误
- **AND** 不留下僵尸 PTY

#### Scenario: agent 可执行文件不在 PATH 中

- **WHEN** 请求启动一个 PATH 中不存在的命令
- **THEN** 系统返回一个指明该命令未找到的错误，而不是静默失败

### Requirement: 字节流原样传递

系统 SHALL 将伪终端的输出字节原样交给 xterm.js，不解析、不改写、不过滤；
并 SHALL 将用户输入原样写回伪终端。

#### Scenario: 输出含 ANSI 转义序列

- **WHEN** 子进程输出包含 SGR、光标移动、擦除等转义序列
- **THEN** 交给 xterm.js 的字节与伪终端读出的字节逐字节相同

#### Scenario: 用户输入回传

- **WHEN** 用户在终端中键入字符
- **THEN** 对应字节被原样写入伪终端，子进程收到与原生终端下相同的输入

### Requirement: 尺寸同步

系统 SHALL 在终端可视尺寸变化时，把新的行列数同步给伪终端。

#### Scenario: 窗口尺寸变化

- **WHEN** 应用窗口被调整，导致 xterm.js 的行列数从 `(80, 24)` 变为 `(120, 40)`
- **THEN** 伪终端被 resize 到 `(120, 40)`
- **AND** 子进程收到尺寸变更通知（TUI 按新尺寸重排）

#### Scenario: 启动时的初始尺寸

- **WHEN** 伪终端刚创建
- **THEN** 其行列数等于当时 xterm.js 的实际行列数，而不是某个默认值

### Requirement: 控制子进程的颜色能力

系统 SHALL 控制传给子进程的 `COLORTERM` 环境变量，以决定 agent 使用 16 色调色板还是 24 位真彩。

#### Scenario: 16 色模式（默认）

- **WHEN** 颜色模式设为「统一」
- **THEN** 子进程环境中不含 `COLORTERM`
- **AND** agent 的彩色输出使用 16 个 ANSI 色槽，因而受当前主题的调色板控制

#### Scenario: 真彩模式

- **WHEN** 颜色模式设为「保留 agent 品牌色」
- **THEN** 子进程环境中 `COLORTERM=truecolor`

#### Scenario: 记录各 agent 的实际行为

- **WHEN** 分别在两种模式下运行同一个 agent 并采集其输出字节
- **THEN** 系统记录该 agent 是否发出 `38;2;<r>;<g>;<b>` 形式的真彩序列
- **AND** 该结论写入实验报告（关闭 `DESIGN.md` 的 Q5）

### Requirement: 进程生命周期与清理

系统 SHALL 感知子进程退出并释放伪终端资源，且 SHALL 在应用关闭时终止其启动的所有子进程。

#### Scenario: agent 正常退出

- **WHEN** 子进程退出
- **THEN** 系统收到退出码，释放伪终端句柄
- **AND** 终端界面标记为「已停止」而不是继续显示为活动状态

#### Scenario: 应用关闭

- **WHEN** 应用退出
- **THEN** 其启动的子进程被终止，不留下孤儿进程

### Requirement: 渲染保真度等同于原生终端

在本应用中托管的 agent TUI，其渲染结果 SHALL 与同一 agent 在原生 Windows Terminal 中的渲染结果等效。
本要求是本次变更的验收闸门：任一场景不通过，即触发 `DESIGN.md` D-9 的技术栈反转条件。

#### Scenario: 启动动画

- **WHEN** 在两个宿主中分别启动同一个 agent
- **THEN** 本应用中的启动动画不出现原生终端中没有的撕裂、残影或重复绘制

#### Scenario: 光标形状

- **WHEN** agent 通过 DECSCUSR 请求改变光标形状（如竖条、下划线）
- **THEN** 本应用中的光标形状与原生终端一致

#### Scenario: 重排绘制

- **WHEN** 在 TUI 运行期间反复调整窗口尺寸
- **THEN** 本应用中不出现原生终端中没有的花屏、错位或残留字符

#### Scenario: 全屏 TUI 的屏幕缓冲切换

- **WHEN** agent 进入或退出备用屏幕缓冲（alternate screen buffer）
- **THEN** 切换前后的内容与原生终端一致，不残留上一屏的内容

#### Scenario: 覆盖多个 agent

- **WHEN** 对 `claude`、`pi`、`grok` 分别执行上述场景
- **THEN** 每个 agent 的判定结果被单独记录，而不是只验一个就下结论
