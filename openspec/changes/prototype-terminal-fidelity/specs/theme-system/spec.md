## ADDED Requirements

### Requirement: 主题定义为数据文件

主题 SHALL 是一个 JSON 文件，含 `id`、`name`、`prefers`（`dark` | `light`）以及 `dark` / `light`
两组色值；每组含 `bg`、`chrome`、`line`、`fg`、`dim`、`cursor`、`accent`、`sel`
和一个按标准 xterm 顺序排列的 16 元 `ansi` 数组。

系统 SHALL 加载 `DESIGN.md` 附录 A 定义的 5 套内置主题，并 SHALL 同时加载用户配置目录中的主题文件。
系统 SHALL NOT 提供在应用内逐色槽编辑主题的界面。

#### Scenario: 加载内置主题

- **WHEN** 应用启动
- **THEN** `graphite`、`harbor`、`ember`、`paper`、`phosphor` 五套主题可选
- **AND** 每套主题的 `ansi` 数组长度为 16

#### Scenario: 加载用户自定义主题

- **WHEN** 用户在配置目录中放入一个格式合法的主题 JSON
- **THEN** 该主题出现在可选列表中，与内置主题地位相同

#### Scenario: 主题文件格式非法

- **WHEN** 配置目录中的某个主题文件缺少必需字段，或 `ansi` 数组长度不是 16
- **THEN** 系统跳过该文件并记录一条指明文件名与具体问题的告警
- **AND** 其余主题正常加载，应用不崩溃

#### Scenario: 用户主题与内置主题 id 冲突

- **WHEN** 用户主题的 `id` 与某个内置主题相同
- **THEN** 用户主题覆盖内置主题

### Requirement: 主题与明暗模式正交

主题选择（5 选 1）与明暗模式（跟随系统 / 强制浅色 / 强制深色）SHALL 是两个独立的设置项，
而不是一个包含 10 个条目的扁平列表。

#### Scenario: 跟随系统

- **WHEN** 明暗模式为「跟随系统」且系统处于深色
- **THEN** 应用使用当前主题的 `dark` 组色值

#### Scenario: 系统明暗变化

- **WHEN** 明暗模式为「跟随系统」，且系统在应用运行期间从浅色切到深色
- **THEN** 应用即时切到当前主题的 `dark` 组，无需重启

#### Scenario: 强制明暗

- **WHEN** 明暗模式为「强制浅色」而系统处于深色
- **THEN** 应用使用当前主题的 `light` 组色值

#### Scenario: 主题身份优先于其偏好

- **WHEN** 当前主题为 `paper`（`prefers: light`），明暗模式为「跟随系统」，且系统处于深色
- **THEN** 应用使用 `paper` 的 `dark` 组，而不是切换到别的主题

### Requirement: 主题映射到终端调色板

系统 SHALL 把当前生效色值组的 16 元 `ansi` 数组与 `bg` / `fg` / `cursor`
映射到 xterm.js 的 `theme` 配置。

#### Scenario: 映射到 xterm.js 的键名

- **WHEN** 应用一套主题
- **THEN** `ansi[0..7]` 映射到 `black`、`red`、`green`、`yellow`、`blue`、`magenta`、`cyan`、`white`
- **AND** `ansi[8..15]` 映射到对应的 `brightBlack` … `brightWhite`
- **AND** `bg` / `fg` / `cursor` 映射到 `background` / `foreground` / `cursor`

#### Scenario: 运行中切换主题

- **WHEN** 在一个已有输出的活动终端上切换主题
- **THEN** 已经绘制的内容按新调色板重绘，不需要重启进程或清屏
- **AND** 终端中的文本内容不发生变化

### Requirement: 主题映射到应用外壳

系统 SHALL 把 `chrome`、`line`、`fg`、`dim`、`accent`、`sel` 映射到应用外壳使用的 CSS 自定义属性，
使 explorer、tab 栏与边框随主题变化。

#### Scenario: 外壳随主题更新

- **WHEN** 切换主题
- **THEN** explorer 背景、tab 栏、边框、选中态、次要文字颜色同步更新

### Requirement: 默认配置

首次启动时，系统 SHALL 使用 `graphite` 主题，明暗模式 SHALL 为「跟随系统」。

#### Scenario: 首次启动

- **WHEN** 不存在任何已保存的主题设置
- **THEN** 当前主题为 `graphite`，明暗模式为「跟随系统」

#### Scenario: 设置被保留

- **WHEN** 用户切换到 `harbor` 后重启应用
- **THEN** 应用仍使用 `harbor`
