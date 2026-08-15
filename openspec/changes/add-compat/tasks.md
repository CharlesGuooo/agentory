## 1. 路径解析收口

- [x] 1.1 `src/main/paths.ts` —— 15 处写死的 `homedir()` 全部收进来
      （实测：`grep homedir() src/main` 现在只剩 paths.ts 自己）
- [x] 1.2 **候选列表而不是一条规则**：环境变量优先，按顺序取第一个存在的
- [x] 1.3 `tried` 记下试过的每一个 —— 诊断面板据此说「我们找了这几个地方」
- [x] 1.4 都不存在时返回**第一个候选**而不是空 —— 界面才说得出「我们期望它在这」
- [x] 1.5 空串的环境变量当没设
- [x] 1.6 环境变量指向的目录不存在时**回落到默认位置**，而不是就此认定「没有」
- [x] 1.7 pi **没找到覆盖变量，所以只有一个候选** —— 没找到就不编一个
- [x] 1.8 14 个测试

## 2. 「别人的机器」

> 传路径参数只验了读取逻辑，**验不到「路径是怎么算出来的」那一段** ——
> 而那正是这一刀新改的东西。所以这一组用 `vi.stubEnv` 走真实解析链路。

- [x] 2.1 `CLAUDE_CONFIG_DIR`：skills 和会话目录都要从新位置读
- [x] 2.2 `CODEX_HOME` / `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` / `GROK_HOME`
- [x] 2.3 `XDG_CONFIG_HOME` **同时影响 opencode 和 grok**（一个变量管一批）
- [x] 2.4 `GROK_HOME` 优先于 `XDG_CONFIG_HOME`
- [x] 2.5 只装一部分 / 一个都没装 → `missing`，不崩
- [x] 2.6 **`empty` / `missing` / `unreadable` 三者必须分得开** ——
      把「读不动」显示成 0 条，就是告诉用户「你没配」
- [x] 2.7 中文 + 空格 + 括号的路径
- [x] 2.8 **>260 字符的超长路径**（实测 Node 在本机能处理，现在钉住了）
- [x] 2.9 几百个 project 条目的大 `.claude.json`（294 KB，解析路径 0.4 ms）
- [x] 2.10 **实测撞出来的一条**：TOML 裸键只允许 `A-Za-z0-9_-`，
      中文服务器名不加引号整个文件就非法 —— 这时必须报 `unreadable` 不是 `empty`
- [x] 2.11 15 个测试

## 3. 诊断面板

- [x] 3.1 七条路径 + 找到没找到 + 命中的环境变量 + 试过几个
- [x] 3.2 五个 agent 在 PATH 里解析成什么 + 各有多少会话和 skill
- [x] 3.3 主动指出沉默故障：**「PATH 里有它，但会话和 skills 都是 0」**
- [x] 3.4 **可复制** —— 截图可能糊，文本不会
- [x] 3.5 **只有路径和数量，不含任何文件内容或凭证**
- [x] 3.6 冒烟实测（这就是客户会贴给你的那段）：
      ```
      agentory 0.1.0 · electron 43.4.0 · node 24.18.1 · win32 x64
      路径：
        ✓ claude 配置目录   C:\Users\PC\.claude
        ✓ claude.json      C:\Users\PC\.claude.json
        ✓ codex            C:\Users\PC\.codex
        ✓ opencode 配置     C:\Users\PC\.config\opencode
        ✓ opencode 数据     C:\Users\PC\.local\share\opencode
        ✓ grok             C:\Users\PC\.grok
        ✓ pi               C:\Users\PC\.pi\agent
      Agent：
        claude    cmd-shim:…claude.cmd → …\claude-code\bin\claude.exe   会话 74 · skills 38
        codex     cmd-shim-node:…codex.cmd → C:\Program Files\nodejs\node.exe  会话 65 · skills 38
        opencode  cmd-shim:…opencode.cmd → …\opencode-ai\bin\opencode.exe 会话 166 · skills 18
        pi        cmd-shim-node:…pi.cmd → C:\Program Files\nodejs\node.exe   会话 14 · skills 38
        grok      direct → C:\Users\PC\.grok\bin\grok.exe                会话 120 · skills 3
      ```

## 4. 诊断面板抓到的真 bug（第一次跑就抓到了）

- [x] 4.1 `resolve.ts` 把 codex / pi 解析成 `electron.exe` ——
      `process.execPath` 在 **Electron 主进程**里不是 node，
      而 `electron.exe some.js` 会把 js 当成一个 app 去加载。**这两个 agent 在应用里起不来。**
- [x] 4.2 改成去 PATH 上找真的 node（shim 本来走的也是它），
      找不到再回落 `ELECTRON_RUN_AS_NODE`（它会被子进程继承，所以只在没得选时用）
- [x] 4.3 **旧测试证明不了这一点** —— `session.test.ts` 里那几个用 `process.execPath` 的
      在 vitest 下跑，那里 `execPath` 恰好就是 node，怎么写都对。
      新断言断的是**结果本身**：必须是 node，且不是靠回落
- [x] 4.4 实测修复后：`codex → C:\Program Files\nodejs\node.exe`

## 5. 收尾

- [x] 5.1 全量 **371 个测试通过**（42 个文件，1 跳过 —— 仍是没有 DeepSeek key 那条）
- [x] 5.2 `ponytail-review`：`diagnostics:collect` 那条 IPC 和 preload 方法没有调用方，
      界面用的是 `diagnosticsText` —— 删掉
- [x] 5.3 `DESIGN.md` 新增 D-17

## 6. 这一刀没做的（明确写下来）

- [ ] 6.1 **claude 原生安装的版本检测。** 结构已查清（版本号是
      `~/.local/share/claude/versions/` 下的目录名），但本机的原生安装是残留 ——
      `~/.local/bin` 里根本没有 `claude.exe`，**端到端验不了**。
      按「不许只说应该可以，交付前实际跑过」，没验过的不写。
      现在的表现是「版本未知」（功能降级，不是坏），而诊断面板会显示 exe 路径，可诊断
- [ ] 6.2 **第二个 Windows 账户上的真机验证。** 空家目录、没有任何 agent、
      全新的 DPAPI 上下文 —— 夹具造不出这些
- [ ] 6.3 **Windows Sandbox 验安装包。** 它验的是「安装包在干净机器上能不能装能不能起」，
      不是 agent 配置兼容性。留到发版前
