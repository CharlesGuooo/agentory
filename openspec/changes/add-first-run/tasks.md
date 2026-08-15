# 空机器上的第一印象

> **纪律：先复现，再修。** 每一处都在 `npm run verify:clean` 里跑出过「修之前是什么样」，
> 才动代码。没有复现过的修复不算修复。

## 1. 自动化的空机器（`npm run verify:clean`）

- [x] 1.1 三个环境变量把真应用跑成新机器上的新用户（`USERPROFILE` / `APPDATA` / `PATH`）
- [x] 1.2 **踩到的坑①**：只改 `USERPROFILE` 会让 Electron 直接异常退出
      （0x80000003，一行输出都没有）—— **Chromium 要求
      `%USERPROFILE%\AppData\{Local,Roaming,LocalLow}` 存在**
- [x] 1.3 **踩到的坑②**：PATH 不能剥到只剩 System32，启动器自己要 node。
      剥 agent 所在目录反而更贴近真实：装了 Node 但没装 agent 的机器
- [x] 1.4 `src/main/smoke-clean.ts`：主界面 / 新建会话 / 历史 / Skills与MCP / 设置·诊断
- [x] 1.5 `--shots` 截图

## 2. 复现（修之前的实际输出）

- [x] 2.1 主区：`"或者从历史会话里找回以前的 —— 五个 agent 的会话都在里面，点开就接着聊"`（0 条）
- [x] 2.2 新建会话：`{可点的agent: 0, 开始键禁用: true, 错误行: "", 出路: 0}`
- [x] 2.3 历史：`"没有匹配的会话"` + 5 个 agent 筛选 chip（一条都没有）
- [x] 2.4 harness：`"没有匹配的 skill"` / `"没有匹配的 MCP"`
- [x] 2.5 Agent 区：`{状态: "还没查过最新版", 现在检查可点: true}` —— 点了闪一下又回来
- [x] 2.6 **诊断：`"没发现问题"`** —— 七行 ✗、五行「没装」，而结论是没问题

## 3. 十一处修复

- [x] 3.1 **诊断告警条件**：`exe !== null && …` 漏了「一个都没装」。
      加两条：一个 agent 都没检测到、装了但七条路径全不存在
- [x] 3.2 诊断结论**读结构化的 `problems.length`**，不去数渲染文本里的 `⚠`（数符号是脆的）
- [x] 3.3 主区空态分两套，由「这台机器有没有 agent」决定
- [x] 3.4 **侧栏空态跟着主区走**（同一个信号 `teNoAgent` 的可见性）—— 两处不可能自相矛盾
- [x] 3.5 新建会话：说清原因 + 五个官网链接（系统浏览器打开，preload 只放行 https）
- [x] 3.6 「现在检查」在没有 agent 时禁用 + 「本机没有可检查的 agent」
- [x] 3.7 历史空态区分「一条都没有」与「被筛掉了」
- [x] 3.8 harness 空态同上
- [x] 3.9 **三处 loading 补 `.catch`** —— 这才是真正会「白屏」的入口
- [x] 3.10 `summary/ipc.ts` 存 key 补 `mkdirSync`（两个邻居都有，这里漏了 → 静默丢 key）
- [x] 3.11 主题目录说清在哪；`.desc` 不再限定在 `.field` 下

## 4. 验收（修之后）

- [x] 4.1 空机器：
      ```
      主区显示的是   "没有 agent 那套"
      侧栏          "工作集是空的。先装一个 agent —— 点上面的「新建会话」，那里有各家的官网链接。"
      新建会话       出路可见 true，出路链接数 5
      历史          "还没有任何历史会话 —— 五个 agent 都没有留下会话记录"
      harness       "五个 agent 里一个 skill 都没有" / "一个 MCP 服务器都没有配"
      Agent 区       "本机没有可检查的 agent"，现在检查可点 false
      诊断           1 个问题
      ```
- [x] 4.2 **正常环境对照**（确认没把「有 agent」时的文案改坏）：
      `主区显示的是 "有 agent 那套"` · `出路可见 false` · `现在检查可点 true` · 439 条会话
- [x] 4.3 截图：空机器的主界面与新建会话
- [x] 4.4 全量 **371 个测试通过**，`tsc` 干净

## 5. 一条被撤回的 ponytail 建议

- [x] 5.1 `smoke-clean.ts` 的 `say`/`wait`/`run` 看着是从 `smoke.ts` 抄的，
      但**实现不一样**（`run` 一个传 `userGesture` 一个不传）。统一要先统一行为，
      那等于改动 20 个正在通过的冒烟模式 —— **为省 6 行冒这个险不划算**。
      理由写进注释，重复保留

## 6. 我原本外包给用户的三件事，两件自己做了

被问「你不能帮我做吗」之后重新查了一遍能力边界，结论是**我把不该外包的也外包了**：

- 建本地用户：`New-LocalUser` 返回 `Access denied`，会话没提权；`PC` 虽在管理员组，
  但 UAC 的同意框在**安全桌面**上 —— 这条确实做不了
- 桌面自动化：这个会话**没有 computer use**，只有 `chrome-devtools` / `playwright`
  两个**浏览器**自动化 —— 点不了 Windows 的窗口

但另外两件不需要那些：

- [x] 6.1 **DPAPI 往返**（`npm run verify:dpapi`）—— 我说它「只有第二个账户能验」是错的。
      跑两次应用共用同一个假家目录：第一次填 key 保存，第二次**全新进程**读回来。
      ```
      [dpapi-set]  {"占位":"已保存（重新填写可覆盖）","输入框已清空":true}
      [dpapi-file] 密文写下了：62 字节  <假家目录>\AppData\Roaminggentory\deepseek.key
      [dpapi-file] 密文里含明文：否 ✓          ← 加密真的发生了
      [dpapi-check] {"解密成功":true}          ← 换进程也解得开
      ```
      它同时覆盖了 3.10 那个缺 `mkdirSync` 的洞（假家目录里 userData 一开始不存在）
- [x] 6.2 **安装包真装一遍** —— NSIS 支持 `/S` 静默 + `/D` 指定目录，不用点任何 GUI：
      ```
      安装退出码 0（不需要管理员）→ agentory.exe + Uninstall agentory.exe
      用装出来的 exe 跑空机器验证：主区「没有 agent 那套」、出路 5 个链接、诊断 1 个问题
      卸载退出码 0，目录已删除 ✓
      ```
      **这一条比开发构建更有价值** —— 之前所有验证跑的都是 `electron-vite preview`，
      而客户拿到的是打包产物
- [x] 6.3 路径又猜错了两次（先猜 `<appdata>/agentory`、再猜 `<appdata>/Electron`），
      两次都报「文件根本没出现」而功能一直是好的。实测真实位置是
      **`<假家目录>/AppData/Roaming/agentory/`** —— 同时设 `USERPROFILE` 和 `APPDATA` 时，
      **Electron 的 appData 从 `USERPROFILE` 推**，`APPDATA` 不起作用。
      改成两个根都搜。**猜错路径的断言比没有断言更糟。**

## 7. 第二个 Windows 账户：跑完了

用户提权建了 `agentory-test`，其余我用 `Start-Process -Credential` 驱动 ——
**不需要登录、不需要切用户**。

> **`Start-Process -Credential` 有两个互相矛盾的坑**，都真撞上了：
> 带 `-WorkingDirectory` 它直接拒绝执行；不带它又会继承**调用方**的当前目录，
> 而那是项目目录（在 `C:/Users/PC/` 下），目标用户没权限读 →
> `The directory name is invalid`。
> 解法是先 `Set-Location` 到一个所有用户可读的目录，再不传 `-WorkingDirectory`。
>
> 我事先说过「GUI 可能在别的用户的窗口站里起不来」—— **实测起得来**。

- [x] 7.1 **全新 Windows 配置文件**（`C:/Users/agentory-test`，从没登录过）：
      ```
      安装退出码: 0                       ← 标准用户静默安装，不需要管理员
      主区显示的是: "没有 agent 那套"
      侧栏: "工作集是空的。先装一个 agent —— 点上面的「新建会话」…"
      新建会话: 可点的agent 0，出路可见 true，出路链接数 5
      历史: "还没有任何历史会话 —— 五个 agent 都没有留下会话记录"
      Skills与MCP: 11 个来源全「没有」，pi MCP「不支持」
      Agent 区: "本机没有可检查的 agent"，现在检查可点 false
      诊断: 1 个问题 → ⚠ 一个 agent 都没检测到
      ```
      **和模拟环境逐条一致** —— 三个环境变量那套模拟是可信的
- [x] 7.2 **另一个用户的 DPAPI**：
      ```
      ciphertext: 62 bytes  （在 agentory-test 自己的 AppData/Roaming/agentory/ 下）
      plaintext leaked into file: no       ← 加密真的发生了
      [dpapi-check] {"解密成功":true}       ← 全新进程 + 另一把用户密钥
      ```
- [x] 7.3 **我自己造的一个坑**：第一次跑 DPAPI 那节一行输出都没有，看起来像失败。
      真相是**安装包打于 15:52，而 DPAPI 冒烟模式 16:32 才写** ——
      装进去的 exe 里根本没那段代码（验证：旧包 asar 里没有 `dpapi-set`，新包里有）。
      **陈旧的产物会伪装成功能失败。** 重打包后一次通过

## 8. 还剩什么

- [ ] 8.1 **SmartScreen 的实际观感**。静默安装（`/S`）绕过了它，所以这次没触发。
      真实客户是双击下载来的 exe，会看到「Windows 已保护你的电脑」——
      这是**没有代码签名证书**的必然结果，不是 bug。README 里已经写了那一屏怎么过
