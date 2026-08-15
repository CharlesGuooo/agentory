> 1–5 是纯逻辑 + 真机，严格 TDD。6–7 是界面，走已有的冒烟点击路径 + 截图。

## 1. TOML 解析层（先做，最容易静默错）

- [x] 1.1 `smol-toml` 进 **devDependencies**；实测 `dependencies` 仍只有 `{"node-pty":"^1.1.0"}`
- [x] 1.2 `toml.ts` 是**全项目唯一** import 它的文件；读不动返回 `null` 不抛
- [x] 1.3 对抗测试 11 条，每条对应本机真实存在的构造：
      字面串 `'C:\Users\new'` 的 `\n` 是两个字符 · 基本串 `"C:\\Users\\PC"` 出来是单反斜杠 ·
      `url = "https://x/y#z"  # 注释` 两层分开 · `[mcp_servers."has.dot"]` 是**一个**服务器 ·
      带反斜杠路径的表头之后 mcp_servers 仍找得到 · 内联表与子表 · 多行数组 · 数组表不带崩
- [x] 1.4 **差分测试**：与 Python 3.14.2 的 `tomllib`（完全独立的实现）对键集合。
      实测两边**逐字一致**：codex 22 服务器 / 11 停用，grok 1 / 0。没有 python 就 skip

## 2. 只取键名（秘密的结构性保证）

- [x] 2.1 `keysOf` / `inlineSecretPaths` / `stringsOf` / `safeUrl`，值从不进返回值
- [x] 2.2 **正反各一条** —— 只断言「不含密钥」不够，一个什么都不读的实现也能过；
      必须同时断言「确实读到了键名」
- [x] 2.3 `safeUrl` 丢掉 query 和 fragment（token 常藏查询串，而它对跨 agent 对照零信息量）
- [x] 2.4 **判据被实测修正**：第一版「任何非占位符字符串」把 `env.BLENDER_HOST = "localhost"`
      和 14 个 `NODE_REPL_*` 全标成密钥（31 处大部分误报）。
      改成「字段名像凭证 **且** 值不是环境变量引用」→ **31 → 11 处，零误报**

## 3. 五个读取器

- [x] 3.1 四个 MCP 具体函数（TOML×2、JSON×2，四套字段名），**不抽接口**（D-11）
- [x] 3.2 `argv` 是 opencode 的 `command[]` 与另三家 `command + args[]` 的无损公约数
- [x] 3.3 `disabledInConfig: boolean | null` —— 「没说」≠「说了开」
- [x] 3.4 claude **两个来源都读，不合并、不选胜者**
- [x] 3.5 grok 的 `[compat.claude] mcps = false` 记成来源级说明
- [x] 3.6 skills **一个**函数 + 五个根 —— 逻辑字面上完全相同，抽它不是投机
- [x] 3.7 **skill = 含 `SKILL.md` 的目录**。`ls | wc -l` 给 40/40/21/40/3，
      实测正确结果 **38/38/18/38/3**

## 4. 组装 + 真机

- [x] 4.1 `scanHarness(scope)`，pi 的 MCP 是一条 `unsupported` 记录**而非省略**
- [x] 4.2 真机报告（11 个来源、只有部分 agent 有的 MCP、存着明文凭证的字段）
- [x] 4.3 不变量而非语料数字：pi 恒为 `unsupported` · 无 `unreadable` ·
      `target.kind === "unknown"` 计数为 **0** · `envNames` 全部匹配环境变量名形状 ·
      `catalog.json` / `README.md` / `archived` 不在 skills 结果里
- [x] 4.4 **结构性断言**：零子进程、**零文件写入**（把「不缓存」钉成结构而非纪律）
- [x] 4.5 真机版秘密测试：断言结果里不含 `ghp_…` / `sk-…` / `Bearer …` 形状的串

## 5. 装卸

- [x] 5.1 装 = `cpSync` 整目录（skill 可带 `scripts/` `references/` `assets/`）
- [x] 5.2 三道闸：源必须含 `SKILL.md` · 目标不能已存在 · **名字带 `../` 会被挡住**
- [x] 5.3 卸 = **`shell.trashItem()`**，不是 `rm -rf`，所以不需要确认弹窗
- [x] 5.4 `checkUninstall` 是纯函数（有单测）：必须是 skill 目录 **且** 正好在已知根的下一层
- [x] 5.5 12 个测试

## 6. 界面

- [x] 6.1 独立弹窗（设置面板已经四块，标题还叫「设置 · 外观」）
- [x] 6.2 状态条**先于格子** —— 没有它，空格子会被读成「没配」而不是「读不到」
- [x] 6.3 作用域下拉：全局 + 工作集 / 收藏里的目录
- [x] 6.4 skill 格子可点，MCP 格子五种记号
- [x] 6.5 冒烟实测（**装卸走界面上真正的那条路径，不是直接调 IPC**）：
      ```
      [smoke-hx] {"打开了":true,"概要":"39 个 skill · 22 个 MCP","行数":61,
        "当前作用域":"全局","可点的格子":195,
        "状态条":["claude MCP 9","claude MCP 17","codex MCP 22","opencode MCP 17",
                  "pi MCP 不支持","grok MCP 1","claude skills 38","codex skills 38",
                  "opencode skills 18","pi skills 38","grok skills 3"],
        "MCP记号":["·","●","—","●●!","○","●●","●!"]}
      [smoke-hx-project]   {"当前作用域":"multi_agents_desktop_app","概要":"11 个 skill · 0 个 MCP"}
      [smoke-hx-target]    {"找到目标":true,"skill":"action-first","来源":"~/.claude/skills/action-first"}
      [smoke-hx-install]   {"装上了":true,"grok状态条":"grok skills 4"}
      [smoke-hx-uninstall] {"卸掉了":true,"grok状态条":"grok skills 3"}
      ```
      文件系统确认：装卸前后 grok skills 都是 `markitdown officecli pdf`，完全恢复原状。
      **回收站确认**：`action-first` 在里面，原位置 `C:\Users\PC\.grok\skills`

## 7. 截图才看得见的问题（冒烟全绿的时候界面是错的）

- [x] 7.1 **两个粘性表头叠在一起** —— 都是 `top: 0` 且同属一个滚动容器。
      修法：每个区块自己一个 `.hx-sec` 包裹层
- [x] 7.2 **面板默认落在一个空项目上**（`0 个 skill · 0 个 MCP`）——
      改成默认全局，当前 tab 的目录排下拉第一项
- [x] 7.3 **名字列撑满 900px**，眼睛要横跨大半个面板才能对上格子 —— 整行封顶 760px
- [x] 7.4 作用域下拉显示完整绝对路径 —— `split(/[\/]/)` 少了反斜杠（这条是冒烟抓的）

## 8. 文档

- [x] 8.1 `DESIGN.md` 新增 D-16
- [x] 8.2 `README.md` 加这一节
- [x] 8.3 `ponytail-review` 的结果（已应用）：
      - 「五个 agent 的列表」在仓库里有 **9 份**，这一刀新添了 3 份。
        `sessions/types.ts` 是纯类型零 import，加一个 `ALL_AGENTS` 谁都能用。
        **按「只动任务要求的」，只收自己那 3 份**，另外 6 份记进注释不动
      - 「含 `SKILL.md` 的目录」写了两遍（`skills.ts` 内联 + `install.ts` 的 `isSkillDir`）。
        挪到 `skills.ts`（定义的归属地），`install.ts` 导入
      - `envNames` / `headerNames` 跨 IPC 但没被读过 —— **不是删掉，是接进 tooltip**：
        它们正是「这个 MCP 为什么在这台机器上不工作」的答案
