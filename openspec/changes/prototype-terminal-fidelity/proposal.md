## Why

`DESIGN.md` 的 **D-9** 选定了 Electron + xterm.js + node-pty，但同时写下了本项目**唯一一个可能推翻技术栈的实验**：
node-pty **不暴露** `PSEUDOCONSOLE_PASSTHROUGH_MODE`（Rust 的 `portable-pty` 有），
所以 ConPTY 会把 agent 的输出经自己的屏幕缓冲重绘一遍。

这直接威胁产品的核心承诺 —— **D-3「每个 agent 的原生 TUI 一个像素都不改」**。
如果重绘会让启动动画撕裂、光标形状丢失、resize 花屏，那 passthrough 就从「锦上添花」变成「必须」，
整个技术栈要换成 Tauri。

**必须最先做**：后面五个适配器、explorer、工作集、摘要的工作量再大，也不会因为这个实验白做；
反过来，先写完那些再发现终端不保真，代价是整个外壳重写。

同时顺带关闭 `DESIGN.md` 的 **Q5**：各 agent 到底发不发 truecolor —— 这决定 D-3 里 `COLORTERM` 旋钮的默认值，
也决定那 5 套主题（附录 A）到底能覆盖 agent 输出的多少。

## What Changes

- 建立项目骨架：Electron + TypeScript + Vite，Windows 打包链路（node-pty 需要原生模块构建）
- 新增**终端宿主**能力：在应用内起一个 PTY、把字节流接到 xterm.js、双向同步尺寸、
  进程退出时清理。**只做这些** —— 按 D-2，终端层不写任何自有功能
  （不做复制粘贴增强、不做 scrollback 搜索、不做 URL 检测、不做分屏）
- 新增**主题系统**能力：加载 `DESIGN.md` 附录 A 的 5 套主题定义，
  映射到 xterm.js 的 `theme`（16 ANSI + bg/fg/cursor）和外壳的 CSS 变量；
  主题（5 选 1）与明暗（跟随系统 / 强制浅 / 强制深）**正交**
- 建立**保真度验收流程**：在同一台机器上，同一个 agent 会话，
  对比「原生 Windows Terminal」与「本应用」的渲染结果，逐项判定
- 产出一份**实验报告**，写回 `DESIGN.md`：D-9 的反转触发条件是否命中、Q5 的答案

**不在本次范围**：五个 agent 的适配器、会话索引、工作集、explorer、tab 管理、恢复、摘要。
本次只起**一个新的 claude 会话**，不涉及 resume。

## Capabilities

### New Capabilities
- `terminal-host`: 在应用内托管一个 agent 的原生 TUI —— PTY 生命周期、字节流绑定 xterm.js、
  尺寸同步、传给子进程的环境变量（含 `COLORTERM` 旋钮）、进程退出处理
- `theme-system`: 主题的定义格式、加载、以及到 xterm.js `theme` 与外壳 CSS 变量的映射；
  主题选择与明暗模式的正交组合

### Modified Capabilities
（无 —— 这是本项目的第一个变更，`openspec/specs/` 为空）

## Impact

- **新增依赖**：`electron`、`node-pty`（原生模块，需 Visual Studio Build Tools 2022 —— 本机已装）、
  `@xterm/xterm`、`@xterm/addon-fit`、TypeScript + Vite 工具链
- **平台**：Windows 11（本机 build 26200）。ConPTY 要求 Windows 10 1809+
- **不影响现有代码**：项目目前只有文档，无代码
- **风险出口**：若保真度验收不通过，按 D-9 改用 Tauri + `portable-pty`。
  届时 xterm.js 绑定与主题映射两部分可原样保留，只换 PTY 后端与进程外壳
- **文档**：实验结论回写 `DESIGN.md` 的 D-9 与 Q5
