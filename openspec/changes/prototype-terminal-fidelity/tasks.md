> **顺序不可调换**：第 1、2 组必须先于第 3 组（design.md 的 D-P2）。
> 如果第 2 组的闸门判定为「反转」，第 3 组之后的 PTY 后端要换成 Rust —— 在写任何 Electron 代码之前知道这件事，能省掉整个外壳的返工。

## 1. 双探针字节对比（先于一切代码）

- [x] 1.1 写固定的输入脚本：启动 → 三次 resize → Ctrl+C 退出，保证两个探针的输入完全一致。
      **不发任何文本输入** —— 实测中 `/help`+回车在 codex 的升级对话框上选中了「立即更新」，
      触发 `npm install` 把 codex 卸掉重装。探针已硬编码禁用 `send` 与 `enter`。
- [x] 1.2 写 `probes/pty-node/`：Node + `node-pty`，起 agent、喂 1.1 的输入、把 PTY 读到的**原始字节**原样存盘（不解码、不加工）
- [x] 1.3 写 `probes/pty-rust/`。**方法论已修正**：upstream `portable-pty` 把标志硬编码，
      `PSEUDOCONSOLE_PASSTHROUGH_MODE` 带 `#[allow(dead_code)]`，没有 API 能打开。
      改为 vendor 到 `probes/vendor/` 并打一行补丁让标志组从环境变量读取，
      **同一个二进制翻转 flags=0 与 flags=8，只差一个 bit**
- [x] 1.4 写对比脚本：统计两份字节流中 `ESC[<n> q`（DECSCUSR）、`ESC[?1049h/l`（备用屏幕缓冲）、`ESC[38;2;r;g;bm`（真彩）的出现次数与位置，以及 resize 前后的重绘字节量
- [x] 1.5a node 探针跑完**五个** agent，全部 `replacementChars=0`（字节无损）。已产出画像：
      真彩 claude 76 / codex 5 / opencode 430 / pi 214 / grok 2315；256 色仅 codex 21 个
- [x] 1.5b Rust 探针 A/B 完成：claude / codex / pi / grok 四个 agent × flags 0 与 8，
      外加 grok / codex 各 3 次同参数重复以测量抖动区间。
      **opencode 的 passthrough 臂缺失** —— 它在 Rust 探针下不稳定，但 `flags=0` 同样失败，
      与 passthrough 无关（node 探针采它正常）

## 2. 决策闸门

- [x] 2.1 报告见 `findings.md`：**没有任何一类转义序列只在一侧出现**；计数差异全部落在同参数重复的抖动区间内
- [x] 2.2 **判定：反转触发条件未命中 → 继续 Electron + node-pty。**
      反向证据：`portable-pty` 的出厂标志在这些 agent 上是坏的（`WIN32_INPUT_MODE` 让 `ESC[6n` 无人应答，只收到 4 字节），
      改用 Tauri 反而要打补丁
- [x] 2.3 **Q5 已关闭**：五个 agent 全部直接发 24 位真彩，**不看 `COLORTERM`**。
      Claude 的 A/B 对照（设 `COLORTERM=truecolor` vs 不设）输出**逐字节相同**（各 15902 字节）。
      **那个旋钮不存在，已从 D-3 删除**；16 个 ANSI 色槽的实际影响远小于原先假设
- [x] 2.4 不适用 —— 未反转，按原计划进入第 3 组

## 3. 项目骨架

- [x] 3.1 `package.json` + `electron-vite` 4.0.1 + TS 5.9.3 + Vite 7.3.6，三段构建通过。**Electron 钉死 43.4.0**
- [x] 3.2 主窗口跑起来，`contextIsolation: true` / `nodeIntegration: false`（`sandbox: false` 以支持 ESM preload；边界靠 preload 只暴露白名单）
- [x] 3.3 **结论：根本不需要 ABI 重建。**
      `electron-rebuild` 确实失败（node-pty 的 binding.gyp 仍依赖 winpty，其 `GetCommitHash.bat` 调用挂掉），
      但 node-pty 依赖 `node-addon-api`（N-API），加载器在 `build/` 缺失时回退到 `prebuilds/win32-x64/`。
      实测在 **Electron 40（ABI 143）和 43（ABI 148）两个不同 ABI 下都能加载并成功 spawn** ——
      ABI 真的变了它照样能用。已删除 `@electron/rebuild` 依赖与 `postinstall` 钩子。
      验证脚本保留为 `npm run verify:node-pty`
- [x] 3.4 xterm 6.0.0 + addon-fit 渲染成功，自检 `screenMounted:true`、`themeBackground:"#16181D"`（GRAPHITE 深色）
- [x] 3.5 Vitest 3.2.7 跑通。首个被测单元是 `src/shared/ansi.ts` 的 `ansiSlotName`（任务 5.2 要用），3 个测试通过；`npm run typecheck` 亦通过

## 4. terminal-host

- [x] 4.1 测试先行，全部通过。cwd 检查放在碰 node-pty 之前 —— 失败时不可能留下僵尸 PTY
- [x] 4.2 `src/main/terminal/session.ts`。**刻意不 import Electron**，因此能在纯 Node 下用 vitest 起真进程测试
- [x] 4.3 preload 白名单：`spawn/write/resize/kill/onData/onExit`，不暴露 `ipcRenderer` 本身。另加 `src/main/terminal/resolve.ts` 解析 npm 的 `.cmd` shim（五个 agent 全部解析通过，7 个测试）
- [x] 4.4 **规格已按实测修正**：ConPTY **不是字节透传**，而是按最终屏幕状态重绘 ——
      它会加自己的前导、插入 `[2J`/`[H`、重排序列顺序。
      四个关键序列（真彩 / DECSCUSR / 备用屏 / 内容）**一个不少**，但字节相邻关系会变。
      因此断言改为"每个序列都到达"，相邻关系不属于保真度。详见 findings.md §2b
- [x] 4.5 **已验证**：`AGENTORY_COMMAND=claude` 启动，内嵌终端里完整渲染出
      Claude Code v2.1.220 的 ASCII logo、输入框边框、状态行。
      加了 `__agentoryDump()` 把 xterm 缓冲区导出成文本，命令行下可验证而不必截图
- [x] 4.6 两个测试都过：初始尺寸用 `mode con` 验（111x37）；resize 后再 `mode con` 验新尺寸（133x41）
- [x] 4.7 `addon-fit` + `ResizeObserver`；`term.onResize` 把新行列推给 PTY
- [x] ~~4.8 颜色模式开关~~ **已作废**（见 2.3）：五个 agent 都无视 `COLORTERM`，这个设置项做不出来，不实现
- [x] 4.9 退出码透传（`exit 7` → 7）；对已死会话再 kill 不抛错；`app.on("will-quit")` 调 `killAllSessions()`
- [x] 4.10 **实测：20000 行全部收到，0 丢失，8.6 MB / 958ms = 8.61 MB/s。**
      对照实际负载（grok 最大一次采集是 14 秒 100KB），逐块 IPC 富余约 100 倍，**不需要 `MessagePort`**

## 5. theme-system

- [x] 5.1 15 个测试通过。坏主题只跳过并给出**具体原因**，其余照常加载
- [x] 5.2 映射测试通过，并额外断言**外壳专用色不泄漏进终端主题**
- [x] 5.3 单元测试 + 端到端都验了：`paper` 在系统深色 + 跟随系统下给出自己的 dark（`#1D1C19`），不换主题
- [x] 5.4 **从 DESIGN.md 程序化提取**（240 个色值，手抄必错）→ `src/shared/builtin-themes.json`，另有 4 个测试守住它与规格一致
- [x] 5.5 **已验证**：放入 `my-graphite.json` 覆盖内置（bg 变成 `#000000`）；放入坏文件只产生告警「主题 broken 的 prefers 只能是 dark 或 light」，应用不崩
- [x] 5.6 已接通。外壳走 `--c-*` CSS 变量，终端走 `term.options.theme`
- [x] 5.7 已实现（`nativeTheme.on("updated")` → 广播新状态）。**未做端到端验证** —— 命令行无法可靠地切换系统明暗；强制模式的路径已验（paper light `#FCFAF6` / dark `#1D1C19`）
- [x] 5.8 **已验证**：首次启动 graphite + 跟随系统；切到 phosphor 后重启仍是 phosphor，`settings.json` 落盘 `{"themeId":"phosphor","mode":"system"}`

## 6. 保真度验收（视觉辅助证据）

- [x] ~~6.1 并排截图~~ **未单独产出** —— 用户直接在应用里做了判定（6.2），没有生成截图对照物。如实记录
- [x] 6.2 **用户真机判定：全部通过**（原话「全部正确」）。
      判定是在跑着真实 claude 会话的应用里做的，覆盖启动动画、重排绘制、备用屏切换。
      **未逐 agent 分别记录** —— 用户是整体判定的，不是五个逐一过。这是实情，不美化
- [x] 6.3 **用户真机复核：五套全部保留**（原话「全部正确，全部留」），附录 A 的色值不做修改

## 7. 结论回写与收尾

- [x] 7.1 `findings.md` 补完：字节对比（§1–§3）+ IPC 吞吐 8.61 MB/s 零丢失（§4）+ 视觉判定与其两处不足（§5）
- [x] 7.2 `DESIGN.md` 已回写：D-9 标记「已验证未命中」、Q5 关闭、附录 A 加注真机复核结论（**色值不做修改**）
- [x] 7.3 `ponytail-review` 已跑并**已应用**：删掉 `src/shared/ansi.ts`（一个调用点的 52 行）、
      `runBench`（答案已记录，无第二次用途）、`prefers` 字段（被校验被测试却无人读取）、
      `app.on("activate")`（macOS 生命周期，Windows 永不触发）、`ExitInfo.signal`（穿三层无人读）；
      `electron.vite.config.ts` 26→10 行（入口全是默认值）；
      `probes/` 加入 `.gitignore`（含 2820 行 vendored 第三方 Rust，本会误入开源仓库）
- [x] 7.4 `probes/` **已删除**（162MB：97MB Rust 构建产物、150KB vendored 第三方源码、
      1.2MB 含真实会话内容的采集文件）。重建所需信息全部保留在 `findings.md`：
      两个库的标志值、补丁位置与做法、输入脚本构成、对比方法。
      `resolve-agent.mjs` 的逻辑已移进 `src/main/terminal/resolve.ts` 并有测试覆盖
