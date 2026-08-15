## Context

项目当前只有文档，没有代码。`DESIGN.md` 已经定下 14 条决策，其中 **D-9**（Electron + xterm.js + node-pty）
附带了本项目唯一一个可能推翻技术栈的实验：node-pty 不暴露 `PSEUDOCONSOLE_PASSTHROUGH_MODE`，
ConPTY 会把子进程输出经自己的屏幕缓冲重绘一遍，可能损害 **D-3**「agent 原生 TUI 一个像素都不改」。

本机环境（已实测）：Windows build 26200（≥ 22621，支持 passthrough）、node v24.13.0、
cargo/rustc 1.93.0、Visual Studio Build Tools 2022 均已安装。五个 agent CLI 全部可用。

本变更的产出是**一个决定**加上一小段可延续的代码：
若保真度通过，`terminal-host` 与 `theme-system` 直接成为 MVP 的第一层；
若不通过，PTY 后端换成 Rust，xterm.js 绑定与主题映射两部分原样保留。

## Goals / Non-Goals

**Goals:**
- 用**可复现的证据**判定 ConPTY 无 passthrough 是否损害 TUI 保真度，而不是靠肉眼印象
- 关闭 `DESIGN.md` 的 Q5：各 agent 是否发真彩序列，决定 `COLORTERM` 旋钮的默认值
- 立起 Electron + TS + Vite 骨架，跑通 node-pty 原生模块在 Windows 上的构建
- 实现 `theme-system` 到可切换 5 套主题的程度，验证附录 A 的 240 个色值在真实 xterm.js 下成立

**Non-Goals:**
- 五个 agent 的适配器、会话索引、工作集、explorer、tab 管理、恢复、摘要 —— 全部不在本次
- 会话 resume —— 本次只起新会话
- 打包分发、自动更新、图标、安装器
- 任何终端功能增强（D-2：不做复制粘贴增强 / scrollback 搜索 / URL 检测 / 分屏）

## Decisions

### D-P1 · 保真度用「双探针字节对比」判定，不用肉眼

**这是本变更最重要的方法论决策。** 规格里写的「与原生终端等效」如果靠人眼看截图，
结论会是「看起来差不多」——那正是 `CLAUDE.md` 明令禁止的交付方式。

做法：写两个**一次性探针**，跑同一个 agent、喂同一段输入、用同一个终端尺寸，把 PTY 读到的**原始字节**各自存盘，然后 diff。

| 探针 | 实现 | 关键差异 |
|---|---|---|
| `probes/pty-node/` | Node + `node-pty` | ConPTY **无** passthrough（经屏幕缓冲重绘） |
| `probes/pty-rust/` | Rust + `portable-pty` | ConPTY **开** `PSEUDOCONSOLE_PASSTHROUGH_MODE` |

两份字节流的差异，**就是 passthrough 的实际影响**，可量化、可复现、可写进报告。
重点比对这几类序列是否被 ConPTY 吞掉或改写：

- `ESC [ <n> SP q`（DECSCUSR，光标形状）
- `ESC [ ? 1049 h/l`（备用屏幕缓冲切换）
- `ESC [ 38;2;<r>;<g>;<b> m`（24 位真彩，同时回答 Q5）
- `ESC [ 8 ; <rows> ; <cols> t` 与 resize 前后的重绘量

**被否决的替代方案**：
- *肉眼并排截图* —— 结论不可复现，且「差不多」不构成推翻技术栈的依据。仍会做，但只作辅助证据。
- *只跑 node-pty 探针，凭经验判断* —— 没有对照组就没有结论。
- *直接抓 Windows Terminal 的字节流* —— WT 不暴露这个，做不到。

Rust 探针约 50 行，cargo 已装。为一个「要不要用 Rust 重写整个应用」的决定花一小时写对照组，是划算的。

### D-P2 · 探针先于应用

任务顺序上，**双探针的字节对比必须排在 Electron 骨架之前**。
如果 diff 显示 passthrough 有实质影响，我们在写任何 Electron 代码之前就知道要换栈，
省掉整个外壳的返工。骨架搭起来之后再验，是最贵的顺序。

### D-P3 · node-pty 跑在主进程，通过 preload 暴露窄接口

node-pty 是原生模块，不能在开启沙箱的渲染进程里加载。字节流走 `ipcMain` ↔ `ipcRenderer`。

- 保持 `contextIsolation: true`、`nodeIntegration: false`，用 `contextBridge` 只暴露
  `spawn / write / resize / onData / onExit` 五个方法
- **不用** `utilityProcess`：本次只有一个终端，主进程足够；等真的要跑 8 个会话时再谈进程隔离

**已知风险**：agent 输出量大时，逐块 IPC 可能成为瓶颈。本次先用普通 IPC 并**测量吞吐**；
若成为问题，改用 `MessagePort` 建立渲染进程与主进程的直连通道。不预先优化。

### D-P4 · 主题是内置 JSON + 用户目录 JSON，加载即数据

- 内置 5 套随应用打包
- 用户主题放 `app.getPath('userData')/themes/*.json`，同 `id` 覆盖内置
- 生效色值组 → xterm.js 的 `theme`（16 ANSI + bg/fg/cursor）与外壳的 CSS 自定义属性
- 按 D-14，**不做取色器 UI**

明暗模式跟随系统时用 `nativeTheme.shouldUseDarkColors` 并监听其变化事件。

### D-P5 · 保真度验收覆盖 claude / pi / grok 三个 agent

不是五个。理由：这三个是最近实际在用的（Claude 今天、Pi 昨天、Grok 8-05），
而 Codex 与 OpenCode 已停用一个月。三个足以暴露差异；每个 agent 的结论**单独记录**，
不允许验一个就推广到全部。

## Risks / Trade-offs

| 风险 | 缓解 |
|---|---|
| ~~node-pty 对 Electron ABI 的原生模块重建在 Windows 上失败~~ | **✅ 已解决，且方式与预期不同。** `electron-rebuild` 确实失败（node-pty 的 binding.gyp 仍依赖 winpty，`GetCommitHash.bat` 调用挂掉），**但根本不需要重建** —— node-pty 依赖 `node-addon-api`（N-API），其加载器在 `build/` 缺失时回退到 `prebuilds/win32-x64/`。实测在 Electron 40（ABI **143**）与 43（ABI **148**）下都能加载并成功 spawn。已删除 `@electron/rebuild` 依赖与 `postinstall` 钩子；验证保留为 `npm run verify:node-pty` |
| **逐块 IPC 成为吞吐瓶颈** | 本次测量而不预先优化；超标则换 `MessagePort` |
| **ConPTY 重绘确实损害保真度** | 这正是本变更要回答的问题。出口已设计好：按 D-9 换 Tauri + `portable-pty`，xterm.js 绑定与主题映射可原样保留 |
| **Rust 探针把第二套工具链带进仓库** | 探针放 `probes/`，是一次性的对照实验，**不进应用构建**；结论产出后可删 |
| **三个 agent 结论不一致**（比如 claude 通过、grok 不通过） | 判定规则事先写死：**任一 agent 不通过即触发反转**。不允许事后放宽标准 |
| **主题色值在真实 xterm.js 下与浏览器预览不一致** | 附录 A 的色值只在浏览器里验过；本次在真实 xterm.js + 真实 agent 输出下复核，差异回写 `DESIGN.md` |

## Open Questions

- **Q5（本次关闭）**：claude / pi / grok 各自是否发 `38;2;` 真彩序列？决定 D-3 中 `COLORTERM` 旋钮的默认值。
- **IPC 吞吐的实际数字**：需要实测才知道要不要上 `MessagePort`。本次只测量并记录，不据此设计。
- **不在本次范围**：Q4（其余四个 agent 的 resume 是否就地追加）、Q6（项目名 / license）、Q7（End session 是否杀进程）。
