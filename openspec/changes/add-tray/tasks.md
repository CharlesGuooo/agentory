# 托盘常驻 + 三处「说人话」

> **纪律：先复现，再修。** 每一条都有「修之前是什么样」的实际输出。

## 1. 托盘常驻

- [x] 1.1 **复现**（`scripts/verify-tray.cjs`，从进程外面看 —— 应用会死，它留不下输出）：
      ```
      前提检查：✓ 没被锁挡掉  ✓ 会话真的起来了  ✓ 真的走到了叉窗口那一步
      叉掉窗口之后：❌ 应用进程 0 个   ❌ agent 进程 0 个
      ```
- [x] 1.2 `win.on("close")` 拦截 + `win.hide()`；`before-quit` 置 `quitting` 标志
- [x] 1.3 **隐藏而不是销毁**：销毁丢掉全部 xterm 面板与滚动缓冲，而且 `mainWindow`
      变 null 会打断 `second-instance` 与 `notify:bell` 那两条 `if (!win) return`
- [x] 1.4 `Tray` + 右键菜单（打开 / 退出）。**持有引用**，否则被 GC 图标就没了
- [x] 1.5 `second-instance` 从 `if (!win) return` 改成 `showWindow()` ——
      不改的话应用会变成**叫不出来的僵尸**
- [x] 1.6 第一次叉掉时一条系统通知；`settings.json` 加 `trayHintShown`
- [x] 1.7 验收（同一条命令）：
      ```
      叉掉窗口之后：✓ 应用进程 4 个   ✓ agent 进程 1 个 claude.exe
      退出之后：    ✓ 残留 agent 进程 0
      ```

## 2. 退出路径：从来没被测过的那条

- [x] 2.1 **发现**：`app.exit()` 按 Electron 文档「不触发 before-quit 和 will-quit」，
      而冒烟的 quit 回调一直是它 —— **`killAllSessions()` 一次都没跑过**。
      `verify:orphans` 之所以绿，靠的是主进程死亡本身销毁 ConPTY 句柄
- [x] 2.2 `verify-orphans.cjs` 文件头那句「验的是 killAllSessions」与实际代码路径不符，改掉
- [x] 2.3 冒烟加 `QUIT=graceful`（走 `app.quit()`）；`verify:orphans` 两条路各跑一遍
- [x] 2.4 **抓到一个假绿**：`process.exitCode = 1` + `app.quit()` → 实际退出码 **0**。
      `app.quit()` 收尾时自己调 `exit(0)`，把失败吞掉。改成在 `will-quit` 里
      （`killAllSessions()` 之后）用 `app.exit(code)` 带出去。验收：失败→1、成功→0
- [x] 2.5 **最大的风险是挂死**（`close` 拦截挡住 `app.quit()`）：实测 6 秒正常退出。
      九个冒烟模式横扫，全部在超时之前退出
- [x] 2.6 验收：`hard` 与 `graceful` 两条路，各五个 agent，退出后残留均为 0

## 3. 一个假的复现（比假绿更糟）

- [x] 3.1 第一版 `verify-tray.cjs` 不隔离 userData，被用户自己正在跑的实例用单实例锁挡掉，
      **什么都没跑**，然后「agent 进程 0 个」看起来像成功复现了 bug
- [x] 3.2 修：所有 verify 脚本各用各的 `--user-data-dir`；并加**前提检查**
      （没被锁挡掉 / 会话真的起来了 / 真的走到了那一步）—— 前提不成立时结论一律无效
- [x] 3.3 第二版又踩一个：`execFileSync` 的 sleep **阻塞事件循环**，
      子进程的 `data` 事件在等待期间一次都不触发，靠输出判断的前提检查全部误判。改异步

## 4. DeepSeek：灰掉 + 说清原因

- [x] 4.1 **复现**：`{"动作区":false, "状态":"已缓存 0 条 · deepseek-v4-flash · 每条约 $0.0002"}`
      —— 三个按钮整排消失，状态行一个字没提要 key
- [x] 4.2 说明段落**从头到尾没提过要一把 DeepSeek 的 key，更没说去哪申请**。补上 + 链接
- [x] 4.3 `hidden` 改 `disabled` + 原因（照 `verCheck` 先例：**原因排在三元的第一支**）
- [x] 4.4 **「看看会发送什么」不禁用** —— 纯本地拼载荷、不出网、不需要 key，
      恰恰是还没拿到 key 的人最该先点的那一个
- [x] 4.5 顺带修 `.btn-ghost:disabled`（**这条规则原来不存在**，禁用的「现在检查」
      看起来和能点的一模一样）
- [x] 4.6 顺带修 `data-url` 委托只挂在 `#newNoAgent` 上 —— 往别处加外链会**点了毫无反应**。
      改文档级委托
- [x] 4.7 验收（DOM + 截图两样都看）：
      ```
      {"开关":"已开启","动作区隐藏":false,"看看会发送什么可点":true,
       "两个生成键禁用":true,"状态行":"还差一把 DeepSeek API key —— 填进上面那个框，下面两个按钮才能用"}
      ```

## 5. 「未启动」→「点击恢复」

- [x] 5.1 状态字说**可做的动作**，并与上方横幅「上次留下 N 个会话」统一措辞
- [x] 5.2 第三行的命令去掉 `opacity: 0.7`（`--c-dim` 上再叠一层，两层衰减几乎看不见，
      而那一行恰恰是「未启动是什么意思」的答案）
- [x] 5.3 `smoke.ts` 里唯一一处**行为上**依赖这个字面量的地方同步改
- [x] 5.4 验收：`START_MEMBER=1` 找得到目标并启动成功；截图确认命令行读得清

## 6. agentory → Agentory

- [x] 6.1 改：`productName`、`shortcutName`、全部可见文案、README 与资产名
      （产物已变成 `Agentory-0.1.0-x64.exe`）
- [x] 6.2 **不改**：`appId`（NSIS 升级与卸载入口的唯一键）、`package.json` 的 `name`、
      `AGENTORY_*` 环境变量、`window.agentory` 桥、`__agentory*` 钩子、
      `openspec/**` 与 `DESIGN.md` 里的历史记录
- [x] 6.3 **一个被推翻的假设**：`userData` 来自 `package.json` 的 `name`，
      不是 `electron-builder.yml` 的 `productName`。实测 `%APPDATA%\agentory` 与
      `%APPDATA%\Agentory` 是同一个目录（磁盘真名小写）—— 数据不可能搬家
- [ ] 6.4 **还没验**：装一遍确认没有第二个安装目录 / 第二条卸载记录。
      需要先关掉正在跑的那份 0.1.0（里面有活着的 claude 会话），所以留给用户决定时机

## 7. 一个第六次踩到的坑

- [x] 7.1 种测试数据时用了 `C:\\Users\\...`，落到文件里成了单反斜杠，
      `\U` 不是合法 JSON 转义 → 工作集读不出来。**应用正确地拒收并报了 2 条告警**，
      是测试数据坏了不是应用坏了。一律改用正斜杠

## 8. 验收

- [x] 8.1 46 个测试文件 / 407 通过 / 1 跳过；`tsc` 干净
- [x] 8.2 `verify:tray` · `verify:clean` · `verify:broken` · `verify:orphans`（两条路）全过
- [x] 8.3 冒烟九个模式横扫，无一挂死
- [x] 8.4 截图：侧栏「点击恢复」+ 命令行可读；摘要区无 key 时的禁用态
