# 发布前的全盘测试

> **纪律：先复现，再修。** 下面十一处每一处都先跑出「修之前是什么样」才动代码，
> 输出贴在各条里。没有复现过的修复不算修复。

## 0. 为什么不按功能清单

- [x] 0.1 量了覆盖缺口（源码/测试行数比）：`sessions` 1.45× · `workspace` 1.23× ·
      `harness` 1.17× · `terminal` 1.15× · `agents` 0.61× · `summary` 0.40× ·
      **`theme` 0** · **`renderer` 0.06×**
- [x] 0.2 静态查「导出了但测试里一次都没引用过」：`renderer/shell.ts` **21 个导出全中**，
      外加 `harness.ts` / `menu.ts` / `theme/service.ts` / `diagnostics.ts`
- [x] 0.3 结论：这个项目已有的 9 个真 bug **没有一个**是列功能清单找到的 ——
      全是「把系统放进真实状态看实际输出」。所以按**层 × 状态**组织

## 1. 第一刀：让已有设施能红（不加新设施）

- [x] 1.1 **25 个冒烟模式此前一个都不会红** —— `quit` 是无条件 `app.exit(0)`，
      `say()` 只打印。发现回归的前提是有人逐行读输出并记得上次的数字
- [x] 1.2 `failures: string[]` + `check()`，收尾 `quit(failures.length ? 1 : 0)`
- [x] 1.3 **进程会计不变量**（每个会话相关模式收尾都跑）：
      `livePids().length === 界面「N 个在跑」`，且 tab 与侧栏成员的 `data-key` 各自唯一
- [x] 1.4 `attachSmoke` 的 async IIFE 补 catch —— **抛错必须退出，不能挂着**
- [x] 1.5 `verify-clean.cjs` / `verify-dpapi.cjs` propagate 退出码（原来注释写着
      「退出码不重要」，那是在断言存在之前）

## 2. 十一个真缺陷

### 同一个根因的三个入口（新 view 对象 + 引用相等去重）

- [x] 2.1 **重复恢复同一条会话**（`FROM_HISTORY=dup`）
      ```
      [FAIL 会计-history] tab 的 key 有重复：claude|49d63048… | claude|49d63048…
      [smoke] workspace: {"total":3,"running":2}     ← 两个进程写同一个会话文件
      ```
      修：`resumeSession` **之前**查 key（事后去重时第二个 pty 已经起来了）+ 在途标志
- [x] 2.2 **双击「未启动」成员**（`START_MEMBER=double`）
      ```
      [FAIL 会计-start-member] 主进程 2 个 pty，界面说 1 个在跑
      ```
      第二个进程界面上没有句柄，✕ 杀不掉 —— 就是「25 个进程活着」的形状
- [x] 2.3 **双击收藏项**（`FAVORITE=open2`）同上。代码自己的注释写着
      「走的是与点未启动的成员**完全同一条路径**」
- [x] 2.4 三处共用一个 `starting: Set<string>`：**光查 `views` 不够**，
      view 是 IPC 回来之后才进去的，那几秒里查不到

### 主进程侧

- [x] 2.5 **换主题把摘要开关重置回默认**（`service.test.ts`，该模块此前 136 行 / 0 测试）
      ```
      × 打开摘要开关之后换主题，开关不会被写回默认值 → expected false to be true
      × 关掉版本检测之后换主题，它不会自己开回来   → expected true to be false
      ```
      两个写入者，一个拿磁盘当真相、一个拿内存当真相。**修法是删掉模块级缓存**
- [x] 2.6 **坏条目在下次正常写入时被销毁**（`entryFile.test.ts`）——
      「绝不替用户销毁记录」只成立到**下一次正常写入**之前。
      修：坏读时留 `<文件>.bak`，**只留第一次**（用户修好文件后再启动，
      备份会被修好的版本盖掉，而那时最需要旧的那份）
- [x] 2.7 后台查版本的 IIFE 没有 catch —— `fetchLatest` 自己不抛了，但缓存写盘会

### 渲染层

- [x] 2.8 **skill 装卸 IPC reject → 整张矩阵永久点不动**（`harness.test.ts`）
      ```
      × 装载 IPC reject 之后，格子还能再点 → expected "spy" to be called 2 times, but got 1
      × 装载 IPC reject 之后，界面要说出原因 → expected '1 个 skill · 0 个 MCP' to contain '目标目录只读'
      + Vitest caught 2 unhandled errors
      ```
      同一个文件往上 45 行为这件事写过注释，第二处漏了
- [x] 2.9 **点起不来的成员，侧栏零解释**（`verify:broken`）
      ```
      [smoke-broken] {"侧栏报错可见":false,"侧栏报错":"","标签页数":0,"在跑":"0 个在跑"}
      ```
      `restoreSerially` 如实带回了 `{ok,error}`，`activate()` 把整个返回值 `void` 掉了。
      新增 `#sideNote`（侧栏此前**没有任何报错出口**）
- [x] 2.10 **`workspaceAdd` 失败 → 孤儿进程**：顺序反了。进程在 `startSession` 时就起来了，
      落盘失败会让 `attach` 永不执行 → agent 连同它的 MCP 子进程界面上看不见。
      改成**先 attach 再 persist**，且 persist 的失败不冒泡
- [x] 2.11 **同目录同 agent 二次新建**：主键在没有 id 时退化成 `agent|cwd:<目录>`，
      而新建的会话**永远拿不到 id**（不回填）。两个成员同 key →
      第二个标签页点不开、✕ 结束第一个、第二个 pty 成孤儿。
      **这条路今天本来就是坏的，只是坏得无声** —— 挡住并说清原因严格优于让它开出来
- [x] 2.12 **三条告警通道接到界面**：扫描 `problems`（166 条会话消失那次在界面上
      只是计数从 437 变 271）、工作集 warnings、收藏 warnings

### 测试设施自己的

- [x] 2.13 **冒烟里任何抛错 → 无限挂死**：`smokeBell` 在没有标签页时
      `querySelector("#tabs .tab").click()` 抛 TypeError，`quit()` 永不执行。
      实测挂了 30 多分钟零输出。**挂起比失败糟得多** —— 失败会被看见，挂起只会被 Ctrl+C
- [x] 2.14 `verify-clean.cjs` 的 `finally` 里 `rmSync` EPERM **把一次全通过报成失败**。
      清理失败不等于验证失败
- [x] 2.15 「整树消失 0 棵」**不是回归** —— 断言暴露了冒烟隐含假设「工作集只有一个成员」，
      它一直点第一个 ✕ 而那是「未启动」的旧成员。第一版用 `!== "未启动"` 仍然错：
      状态有四种（工作中/未启动/已停/需要你），必须白名单
- [x] 2.16 `NEW=1` 跨运行不幂等（撞上 2.11 的新守卫）→ 默认改成每次一个新临时目录

## 3. 渲染层怎么测

- [x] 3.1 装 `happy-dom`（**测试专用 devDependency**）。验证它不进打包产物：
      ```
      npm run build && grep -rl "happy-dom" out/   → 0 处命中
      运行时依赖: {"node-pty":"^1.1.0"}
      ```
- [x] 3.2 **纪律：绝不断言布局、尺寸、可见性** —— happy-dom 返回 0 和假 true。
      只断言 DOM 结构、文本、属性、桩 api 的调用次数。布局继续靠截图
- [x] 3.3 先做 `harness.ts`：import 链最干净（无 xterm / electron），
      `setupHarness(deps)` 已是依赖注入形状，桩件五行。**18 条**，
      覆盖 MCP 五种记号、明文凭证的 `!` 角标（此前零自动守卫）、三种空态、`.hx-sec`
- [x] 3.4 **不给 `main.ts` 搭整体启动测试**：api 桩面 40 个方法，
      一个形状写错的默认值会让测试绿着而界面是坏的 —— 那种测试比没有更糟。
      启动自检交给真冒烟：自检对象在、`bridge === true`

## 4. 四项加固

- [x] 4.1 `app.requestSingleInstanceLock()`。**冒烟模式下被锁挡住要退 1** ——
      残留实例会让冒烟秒退并报「全部通过」，一个什么都没跑过的假绿。实测：
      ```
      [single-instance] 已经有一个 agentory 在跑，这个实例退出
      第二个 exit: 1
      ```
- [x] 4.2 `saveEntryFile` 改「临时文件 + rename」。裸 `writeFileSync` 写一半断电 =
      半个 JSON = 整份工作集读不出来 = 正好触发 2.6 那条销毁链
- [x] 4.3 关面板时 `term.dispose()` + `ResizeObserver.disconnect()`。
      `el.remove()` 两样都不做，而观察器闭包抓着整个终端连同滚动缓冲
- [x] 4.4 三条告警通道（同 2.12）

## 5. 三种机器 profile

- [x] 5.1 `verify:clean`（什么都没有）—— 断言写的是**一致性不变量而不是绝对值**：
      它要在空机器和正常机器上各跑一次。同样六条，空机器「诊断 1 个问题」、
      正常机器「没发现问题」，**两边都过**。写「历史应该 0 条」的话对照那次必然假红
- [x] 5.2 `verify:broken`（我们自己的记录全坏了 + 一条指向已删目录的会话）
      ```
      [smoke-broken] 侧栏报错:"没能启动：工作目录不存在或不是目录：…\已经被删掉的项目目录"
      workspace.json.bak 在 ✓   favorites.json.bak 在 ✓   备份里那条坏记录 原样保着 ✓
      ```
- [x] 5.3 `verify:orphans`（五个 agent 同时在跑，然后正常退出）
      ```
      启动前：全系统 862 个进程，其中 agent 名字的 11 个
      退出后新增的 agent 进程：0 ✓
      ```
      **必须是外层脚本** —— `smokeEnd` 的检查刻意在应用还活着时做（否则 `will-quit`
      的兜底会掩盖漏杀），那么反过来那一半只能在应用死后看

## 6. 只能在真 Electron 里验的

- [x] 6.1 `NEW=all`：五个 agent 各起一次，五个终端都要有真实内容
      ```
      [smoke-all-agents] ["claude","codex","opencode","pi","grok"]   5 个标签页
      ———— codex ————     > You are in C:\…\agentory-smoke-all-RQPxWh
      ———— opencode ————  ~\…\agentory-smoke-all-RQPxWh  ⊙ 9 MCP /status  1.18.18
      ```
      `terminal/resolve.ts` 自己写着单元测试证明不了这件事 —— vitest 下 `execPath` 就是 node，
      「codex / pi 被解析成 `electron.exe`」当年正是这么漏过去的
- [x] 6.2 第一版写错了：上一个 agent 起成功会关掉选择器，chip 是**异步**填的，
      同步去找导致 codex 和 pi 隔一个失败一次。**那是测试的 bug 不是应用的** → 改成轮询

## 7. opencode 库被锁

- [x] 7.1 `BUSY_TIMEOUT_MS` 是为这个存在的（那次事故值 166 条会话），
      但**从没有测试造出过那个状态** —— 当年是并发跑碰巧撞出来的
- [x] 7.2 实测该库是 **WAL**，所以 `BEGIN EXCLUSIVE` 不挡只读连接。
      两种都测：WAL 下 224ms 正常读到；切 `journal_mode=DELETE` 后真被挡，
      **3485ms** 走完 busy_timeout 然后大声失败
- [x] 7.3 `scanAll` 把抛错变成 `[opencode] 扫描失败：…` 而不是悄悄少掉的会话

## 8. 截图

- [x] 8.1 深色 + 浅色两轮，12 张
- [x] 8.2 **截图当场抓到一个**：`#histProblems` 根本没显示 ——
      我在点开历史之后立刻注入文案，而 8 秒后扫描的 `.then` 又把 `hidden` 设回 true。
      冒烟当时是全绿的。注入改到扫描之后
- [x] 8.3 两块新界面（侧栏报错位、历史里的「有来源没读出来」）在两种主题下
      对齐、留白、长路径换行都正确

## 9. 验收

- [x] 9.1 **46 个测试文件 / 407 通过 / 1 跳过**（起点：42 / 371）
- [x] 9.2 `tsc` 干净
- [x] 9.3 `verify:clean` · `verify:broken` · `verify:dpapi` · `verify:orphans` 全过
- [x] 9.4 冒烟全模式横扫全过：NEW · NEW=all · END · FROM_HISTORY · FAVORITE(dead/unstar/open/open2) ·
      START_MEMBER(1/double) · HARNESS · VERSIONS · DIAG · KEYS · BELL · SUMMARY · HISTPERF · SHOT

## 10. 没做的，以及为什么

- [x] 10.1 **网络三种坏的测试**：`fetchLatest` / `grokLatest` 都已 try/catch 返回
      `{ok:false}`，`checking` 有 try/finally，`checkedAt` 有 `if (any)` ——
      都是三行就能看出对的代码，测它只是确认已经对的东西。只补了那一行缺失的 catch
- [x] 10.2 **`main.ts` 的整体启动测试**：见 3.4
- [x] 10.3 **dispose 的内存收益没有量**：可靠地测内存斜率需要一套 churn harness，
      而数字本身噪声很大。改动本身是可读的（`dispose()` + `disconnect()` 确实被调），
      会话生命周期的冒烟仍全过 —— **但没有测出「省了多少」，如实记在这里**
- [ ] 10.4 **同目录多会话**：2.11 是挡住而不是支持。真要支持得给工作集条目
      一个稳定的本地 id —— 那是一次 schema 变更，另开一刀
