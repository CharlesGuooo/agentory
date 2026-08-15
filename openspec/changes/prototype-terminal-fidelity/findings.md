# 实验报告 —— ConPTY passthrough 对 TUI 保真度的影响

日期：2026-08-12 · 对应任务 2.1 / 2.2 · 环境：Windows 11 build 26200

## 判定

> **D-9 的反转触发条件未命中。继续用 Electron + xterm.js + node-pty。**

## 方法

`DESIGN.md` D-P1 原计划用「node-pty vs portable-pty」做 A/B。**这个设计是错的**，
实测发现两个库传给 `CreatePseudoConsole` 的标志根本不同：

| 实现 | 标志 | 依据 |
|---|---|---|
| node-pty | **0**（未开 `conptyInheritCursor` 时） | 其 `src/win/conpty.cc:292`：`inheritCursor ? 1 : 0` |
| portable-pty 0.9.0 | **7** = `INHERIT_CURSOR｜RESIZE_QUIRK｜WIN32_INPUT_MODE` | 其 `src/win/psuedocon.rs:86`，硬编码 |

差三个标志去比 passthrough，等于同时动了四个变量。

**改用：同一个 Rust 二进制、同一条代码路径，只翻转标志组。**
`portable-pty` 被 vendor 到 `probes/vendor/` 并打了一行补丁，让标志从环境变量读取
（upstream 定义了 `PSEUDOCONSOLE_PASSTHROUGH_MODE = 0x8` 但带 `#[allow(dead_code)]`，
没有任何 API 能打开它）。A/B 即 **flags=0 vs flags=8**，只差一个 bit。

输入脚本对两臂完全相同：启动 → 三次 resize → Ctrl+C。**不含任何文本输入**（原因见下方教训）。

## 结果

### 1. 没有任何一类转义序列被吞掉

四个 agent（claude / codex / pi / grok）的 A/B，**「只在一侧出现的序列种类」全部为 0**。
ConPTY 不开 passthrough 时，没有丢失或改写任何序列类别 —— 包括 DECSCUSR（光标形状）
和备用屏幕缓冲切换。

### 2. 计数差异落在运行间抖动内

对 grok 和 codex 各做了 3 次同参数重复，得到抖动区间：

**codex** —— 每一项 passthrough=ON 的值都落在区间内：

| 指标 | 同参数三次 | 区间 | passthrough=ON | 判定 |
|---|---|---|---|---|
| bytes | 8328 / 8164 / 7994 | 7864–8328 | 7899 | 区间内 |
| truecolor | 7 / 5 / 6 | 5–7 | 6 | 区间内 |
| sgrBasic | 109 / 107 / 108 | 107–109 | 108 | 区间内 |
| **decscusr** | 4 / 3 / 3 | 3–4 | 4 | **区间内** |
| cursorHide | 8 / 6 / 7 | 6–8 | 6 | 区间内 |

**grok** —— `sgrBasic` / `decscusr` / `cursorHide` 均在区间内；
`bytes`（103454 vs 区间 68426–100144）与 `truecolor`（2485 vs 1498–2298）略超上沿约 3%，
但 grok 是动画 TUI，同参数三次就在 92k–100k 之间摆动，n=4 的样本下不构成证据。

**claude 与 pi：两臂所有指标完全一致，零差异。**

### 2b. 补充刻画：ConPTY 保留序列，但会重排并按最终屏幕状态重绘（2026-08-13，任务 4.4）

写单元测试时精确测到了「ConPTY 到底对字节做了什么」。
向 PTY 发 `<真彩色码>X<reset><ESC[3 q><ESC[?1049h><ESC[?1049l>`，收到的是：

```
ESC[?9001h ESC[?1004h ESC[?25l ESC[?25l ESC[3 q ESC[2J ESC[m
ESC[38;2;215;119;87m ESC[H X ESC]0;…node.exe BEL ESC[?25h ESC[?1049h …
```

- **四个关键序列一个不少**：真彩、DECSCUSR、备用屏切换、内容本身
- **但顺序和相邻关系变了** —— ConPTY 加了自己的前导（`?9001h`/`?1004h`/`?25l`）、
  把 `[3 q` 提前、插入 `[2J` 与 `[H` 定位，然后按最终屏幕状态重绘

**这与 §1 的结论一致并使之更精确**：不是"字节透传"，而是"语义等价的重绘"。
渲染结果相同，所以**字节相邻关系不属于保真度**。
单元测试因此断言"每个序列都到达"，而不是"它们字节相邻"。

### 3. 反向证据：portable-pty 的默认配置在这些 agent 上是坏的

`flags=7`（portable-pty 出厂值）跑 claude 只收到 **4 字节**就卡死 ——
`WIN32_INPUT_MODE` 让 agent 发出的 `ESC[6n`（DSR，问光标位置）被透传出来而无人应答，
agent 一直阻塞等回复。

**也就是说改用 Tauri + portable-pty 反而需要打补丁才能跑起来。** 这条独立地支持维持 D-9。

## 缺口（必须说明）

1. **opencode 的 passthrough 臂缺失。** 它在 Rust 探针下不稳定，多次尝试均超时 ——
   但 `flags=0` 同样失败（成功过一次，48819 字节），**故与 passthrough 无关**。
   node 探针采它完全正常（46995 字节）。它是两个会发 DECSCUSR 的 agent 之一，
   结论对它属于外推。
2. **字节级无差异 ≠ 渲染级无差异。** 本实验证明的是「ConPTY 没有吞掉序列」，
   最终的视觉保真判定仍需任务 6.x，在真实 xterm.js 里做。
3. 抖动区间只有 4 个样本。

## 附带结论

- **Q5 已关闭**：五个 agent 全部直发 24 位真彩，**无视 `COLORTERM`**。
  Claude 的对照（设 vs 不设）输出逐字节相同。D-3 里那个「降级到 16 色」的旋钮不存在。
- **只有 codex（3–4 个）和 opencode（2 个）发 DECSCUSR**；claude / pi / grok 一个都不发。
- node 探针五个 agent 全部 `replacementChars = 0`，UTF-8 往返无损。
  （node-pty 在 Windows 上不支持 `encoding` 选项，只交付字符串 —— 但对产品无害，
  xterm.js 的 `write()` 本来就收字符串，这正是 VS Code 的路径。）

## 4. IPC 吞吐（任务 4.10）

逐块 `ipcRenderer` 传输，起一个只管狂吐的子进程：

| 指标 | 值 |
|---|---|
| 发出 / 收到 | 20000 行 / **20000 行** |
| 丢失 | **0** |
| 体积 / 耗时 | 8.6 MB / 958 ms |
| 吞吐 | **8.61 MB/s** |

对照实际负载：grok 单次采集最大 100 KB / 14 秒。**富余约 100 倍，不需要 `MessagePort`。**
design.md 说「只测量不优化」，测量结果就是不必优化。

## 5. 视觉判定（任务 6.2 / 6.3）

在跑着真实 claude 会话的应用里，由用户直接判定：

- **渲染保真度：全部通过**（原话「全部正确」）。覆盖启动动画、窗口反复缩放的重绘、备用屏切换。
- **五套配色：全部保留**（原话「全部正确，全部留」）。附录 A 的 240 个色值**不做任何修改**。

**两处如实记录的不足：**

1. **未逐 agent 分别判定。** 规格写的是「五个 agent 各自单独记录」，实际是整体判定的。
2. **未产出并排截图（任务 6.1）。** 用户直接在应用里看，没有生成与原生 Windows Terminal 的对照物。
   这一条是**没做**，不是做了没记。

字节级证据（§1、§2）是自动化且可复现的；视觉这一层是人工且一次性的。两者的可信度不同，不应混为一谈。

## 教训

**盲发按键进 agent 的 TUI 会触发破坏性操作。**
最初的脚本发 `/help` + 回车。codex 启动时弹的是「Update available，1. Update now」对话框，
那个回车选中了它，触发 `npm install -g @openai/codex`，把 codex 卸掉重装（0.146.0 → 0.147.0），
并留下缺失的 shim。已修复并重装。

两个探针现已硬编码禁用 `send` 与 `enter`。要验的五件事本来就不需要打字。
