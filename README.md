# multi_agents_desktop_app — 交接文档

> 写给下一个接手实施的 agent。本文档是上一轮调研 + 实测的结论,**不要重新调研已经写死的部分**。
> 所有"一手事实"都是在这台机器(Windows 11 Pro for Workstations,`C:\Users\PC`)上实测得到的,不是从文档抄的。
> 日期:2026-08-12

---

## 1. 用户要做什么

用户(charlesgxy)同时用 5 个 CLI coding agent,每个开一个 PowerShell 窗口,各在不同目录。痛点有两个:

1. **电脑重启后所有窗口消失**,而且记不清上次开着哪些会话
2. **每个 agent 的会话机制都不一样** —— 重启/恢复会话的命令、存储格式全都不同,人脑要记 5 套

用户想自己做一个开源的桌面 app 来解决。原话要点(**这是产品需求,请尊重**):

- **保留每个 agent 原生的 PowerShell TUI 体验** —— 不要重新发明交互,agent 的启动模式、显示方式原样保留,只做**颜色/主题上的轻微统一**
- 不追求特别精美,但要有 **working station 的感觉**,不是浏览器式的一堆顶部 tab
- **左侧 explorer**,可展开/收起,显示「哪个 local folder 的哪个 agent 正在跑」,点一下切到那个会话
- **顶部 tab 用于并排看多个**;只有一个 tab 时就是单会话切换
- **重启恢复**:下次打开 app,有一个地方能重新启动上次的会话,**由用户勾选启动哪些**
- **每个会话给一句精炼总结**,让人一眼知道这个会话之前在干什么

目标 agent(就这 5 个,不要扩):**Claude Code、Codex、OpenCode、Pi Agent、Grok Build**

---

## 2. 已定的产品定位(不要再讨论)

**这个产品是「跨 agent 会话索引器」(cross-agent session indexer),不是「又一个终端 app」。**

理由:

- 终端外壳(xterm.js + node-pty/ConPTY)是**商品化**技术,已有 Pane 每天发 3 个版本、Nimbalyst 1.5k stars 在做。从零重做一遍不构成差异化。
- 没有任何现有工具做**跨 agent 的统一会话索引 + 统一恢复 + 会话摘要**。这是空白,也正是用户的真实痛点。

**三个核心能力(护城河):**

1. 跨 agent 统一会话索引 —— 一处看见 5 种 agent 在 N 个目录下的所有会话,可排序/分组/搜索
2. 一键恢复 —— 用户点一下,系统自己知道该发 `claude -c` 还是 `codex resume --last` 还是 `grok --session-id xxx`
3. 每个会话一句话摘要 —— 读会话文件尾部 N 条消息 → 小模型 → 缓存

UI 是让这三件事能被用,不是卖点。

---

## 3. 一手事实:五个 agent 的会话系统(最值钱的部分)

全部实测自本机。**这张表就是整个产品的立论,也是适配器的规格书。**

### 3.1 存储层 —— 四种不同范式

| Agent | 会话存储路径 | 范式 | 目录名编码 |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<编码目录>/<uuid>.jsonl` | 按项目分树 | **有损**:`\` 和 `_` 都→`-` |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO时间戳>-<uuid>.jsonl` | **按日期分区** | 路径根本不在文件名里 |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | **SQLite 数据库** | 不适用 |
| **Pi** | `~/.pi/agent/sessions/<编码目录>/<ISO时间戳>_<uuid>.jsonl` | 按项目分树 | 有损:`:`→`--`,`\`→`-`,首尾包 `--` |
| **Grok Build** | `~/.grok/sessions/<URL编码绝对路径>/` | 按项目分树 | **URL 编码,无损** |

**实测样例(照抄,别猜):**

```
Claude : C:\Users\PC\Desktop\Recent\local_GPU
      -> ~/.claude/projects/C--Users-PC-Desktop-Recent-local-GPU/
         (注意 local_GPU 变成了 local-GPU —— 反解会 cd 到不存在的路径)

Pi     : C:\Users\PC\Desktop\Recent\ios_app_idea
      -> ~/.pi/agent/sessions/--C--Users-PC-Desktop-Recent-ios_app_idea--/
         (下划线保留了,但 \ 变成 -,所以 `Resume-build` 无法判断原本是
          Resume\build 还是 Resume-build)

Grok   : C:\Users\PC
      -> ~/.grok/sessions/C%3A%5CUsers%5CPC/     (可无损反解)

Codex  : ~/.codex/sessions/2026/07/15/rollout-2026-07-15T04-00-50-019f64ca-...jsonl
```

### 3.2 如何拿到真实的 cwd(必须处理的坑)

目录名不可信。正确做法是从会话文件里读:

- **Pi**:第 1 行就是 header,直接有 `cwd`。实测:
  ```json
  {"type":"session","version":3,"id":"019e8fba-...","timestamp":"2026-06-03T23:04:11.323Z","cwd":"C:\\Users\\PC"}
  ```
- **Claude**:第 1 行**没有** `cwd`(只有 `mode`/`sessionId`/`type`),必须往下扫。实测扫前 40 行内可命中 `cwd` 字段。
- **Codex / OpenCode / Grok**:尚未验证 transcript 内部结构,见 §6。

> 已验证的参考实现:`C:\Users\PC\scripts\agents.ps1`(见 §7)。

### 3.3 命令层 —— 五套不同的 CLI

实测自各 agent 的 `--help`:

| Agent | 续最近一个 | 弹列表选 | 指定 session |
|---|---|---|---|
| Claude | `-c` / `--continue` | `-r` / `--resume` | `--resume <id>` |
| **Codex** | **`codex resume --last`** | `codex resume` | `codex resume <id>` |
| OpenCode | `-c` / `--continue` | `opencode session` | `-s <id>` / `--session <id>` |
| Pi | `-c` / `--continue` | `-r` / `--resume` | `--session <path\|id>` |
| Grok | `-c` / `--continue` | `--resume` | **`--resume <id>`** ⚠ |

> **⚠ 2026-08-13 实测修正**：上表里 Grok 那格原本写的是 `--session-id <id>`，**是错的**。
> `--session-id` 的语义是「用这个 id，**不存在就创建**」——
> 拿它去恢复，id 对不上时不报错，而是静默开一个新的空会话，用户以为历史回来了。
> 正确的是 `-r, --resume <id>`。Pi 也有同样语义的 `--session-id`，同样不能用于恢复
> （Pi 该用 `--session <path|id>`，原表没错）。
> 已在 `openspec/changes/add-session-resume` 里写成否定性规格要求 + 专项测试。

**关键陷阱:Codex 是唯一用子命令而不是 flag 的**,任何统一封装的第一行代码就要为它开特例。

其他观察:5 个里 4 个都支持某种 `--fork`(fork 出新会话而不复用原 ID),将来可以做「从这个会话分叉」功能。

---

## 4. 已定的架构决策

### 4.1 适配器接口 —— 整个核心就这么小

```ts
interface AgentAdapter {
  id: 'claude' | 'codex' | 'opencode' | 'pi' | 'grok'
  listSessions(): Session[]                    // 扫它自己的存储
  resumeCommand(sessionId, cwd): string[]      // 拼出正确的命令行
  readTranscript(sessionId): Message[]         // 供摘要用
}

interface Session {
  agent: string
  sessionId: string
  cwd: string          // 必须是真实存在的路径(Test-Path 通过)
  lastActivity: Date
  title?: string       // 摘要,可后填
}
```

写 5 个实现,产品就成立。其余全是外壳。

### 4.2 省一半工作量的关键洞察

**「恢复上次会话」这个功能其实不需要读它们的存储。**

因为进程是**你的 app 启动的** —— 启动那一刻你就知道 `(agent, cwd, sessionId, 启动时间)`,自己记一个 **launch ledger** 就行。

只有两种情况才需要去读它们的存储:

1. 用户在你的 app 之外开的会话(比如直接在 PowerShell 里开的)
2. 生成摘要

这一刀切下去,MVP 工作量减半。

### 4.3 摘要功能

读会话文件尾部 N 条消息 → 丢给一个小模型 → 缓存到本地。成本极低,价值最高,目前没有任何竞品做。

### 4.4 MVP 先做 CLI,不做 GUI

理由:
- 适配器是**风险最高**的部分。5 个适配器写不通,GUI 做得再漂亮也没用;写通了,GUI 就是纯体力活。
- CLI 版本**今天就能帮到用户**(他现在 8 个 claude 会话在裸奔)
- 天然适合开源:别人可以贡献第 6、第 7 个适配器

### 4.5 一个技术现实(用户的期望需要校正)

用户说「只需要微微调整它里边的颜色」—— **这做不到字面意义上的那样**。agent 的 TUI 自己发 ANSI 转义序列,你改不了它的语义。你能改的是**终端的调色板映射**(它说"红",你决定这个红长什么样)和背景/字体。观感上确实能统一,但实现方式是主题映射,不是"改它的颜色"。实施时请按主题映射设计,并在文档里说清楚。

---

## 5. 已经否决 / 已经试过的(不要重复)

| 方案 | 结论 |
|---|---|
| **psmux**(Windows 原生 tmux) | **已完整试过并卸载。不要再提。** 装过、配过插件、跑通了 save→kill→restore 全流程。否决原因:它是终端多路复用器,只解决"进程活过关窗口",完全不理解 agent 语义(不知道会话、不会 resume);而且用户明确不要终端派工具。残留已全部清除。 |
| **Spotify Xirp** | 概念对标物,就是这一类工具。但 **macOS only**,公测,需 Spotify 账号,无 Windows 时间表。 |
| **Pane**(dcouple/Pane) | Windows x64/arm64 `.exe` **确有**(v2.4.48,8-12 发)。agent 无关,AGPL-3.0,~380 stars,每天发数版。终端派,做工不算精美。**最接近的竞品。** |
| **Nimbalyst**(前身 Crystal) | Windows `.exe` 确有,MIT,1.5k stars,kanban + 内嵌 ghostty 终端 + 手机端。但**只支持 4 个 agent**(Claude/Codex/OpenCode alpha/Copilot alpha),不支持 Pi/Grok。Windows 下载量仅 680 vs mac 18906,Windows 是次要平台。 |
| **AionUi** | **排除**。最新 release(v2.1.54)零二进制资产,只有源码。 |
| **Claude Code 桌面版** | 官方,Windows x64/arm64 都有,sidebar 就是持久会话列表,做工最好。但**单厂商**,覆盖不了 Pi/Grok/OpenCode。可作为 UI 参考。 |
| **GitHub Copilot app** | Windows 11 可用,每会话独立 worktree,但绑 Copilot 生态。 |

---

## 6. 未决 / 留给你的空白

按重要性排:

1. **技术栈未定** —— Electron + xterm.js + node-pty,还是 Tauri。用户没表态。建议在写计划时给出推荐并说明理由(Windows ConPTY 支持成熟度是关键考量)。
2. **OpenCode 的 SQLite schema 没读过** —— `~/.local/share/opencode/opencode.db`。适配器要能查它,必须先读 schema。
3. **Codex / OpenCode / Grok 的 transcript 消息结构没解析过** —— 只确认了存储位置,没确认消息格式。摘要功能依赖这个。
4. **Grok Build 还在 beta(v0.2.x)**,CLI 会变。适配器需要版本探测 + 测试,否则它一改 flag 就静默坏掉。
5. **项目名、license 未定。**
6. **是否支持 SSH/远程会话** —— 未讨论,建议 MVP 明确不做。

---

## 7. 现有资产

**`C:\Users\PC\scripts\agents.ps1`** —— Claude 适配器的雏形,**已实测可用**。

它做的事:扫 `~/.claude/projects/`,对每个项目目录取最新的 `.jsonl`,**从文件内容里读出真实 `cwd`**(而不是反解目录名),输出「最后活动时间 / 会话数 / 真实目录」表格,并统计当前活着的 claude 进程数。

实测输出示例(2026-08-12):列出 22 个项目目录,路径全部真实存在;当时有 8 个 claude 进程在跑。

**直接拿它当 Claude adapter 的参考实现**,再写另外 4 个。

---

## 8. 你的第一步(单个具体动作)

**实现 5 个 adapter 的 `listSessions()`,并用一个 CLI 把它们并成一张表。**

```
agents ls              # 所有 agent 的所有会话,一张表,按最后活动时间排序
agents resume <n>      # 恢复第 n 个,自动使用正确的命令
agents why <n>         # 这个会话之前在干什么(一句话摘要)
```

**验收标准(必须实际跑过,不许只说"应该可以"):**

- `agents ls` 能同时列出 5 个 agent 的会话
- **每一行的 `cwd` 都通过 `Test-Path`** —— 这是最容易错的地方,Claude 和 Pi 的目录名都是有损编码
- 对 Claude,能列出用户在 `C:\Users\PC\Desktop\Recent\` 下的那批项目
- `agents resume <n>` 对 Codex 生成的是 `codex resume <id>` 而不是 `codex --resume <id>`

---

## 9. Skills:已经配好了,按阶段用

**本项目的 `.claude/skills/` 已预置 5 个本地 skill**(它们是目录作用域的,只在本项目可见)。
其余列出的都是全局 skill,任何目录都能直接调用,**不要再复制进来**。

### 阶段 0 —— 动手前:定接口和词汇

| Skill | 位置 | 用途 |
|---|---|---|
| `codebase-design` | 全局 | AgentAdapter 的三个方法是典型的**深模块 + 接缝**问题,用它的词汇来设计 |
| `domain-modeling` | 全局 | **这个项目的词汇有真歧义**:session / conversation / run / project / workspace,五个 agent 各叫各的。先写 CONTEXT.md 钉死,否则每一层都要翻译 |
| `senior-architect` | **本项目** | 技术栈决策(Electron vs Tauri)、依赖分析、架构图 |
| `writing-plans` | 全局 | 把本文档 §8 拆成实施计划 |

### 阶段 1 —— MVP:五个适配器 + CLI

| Skill | 位置 | 用途 |
|---|---|---|
| `test-driven-development` | 全局 | **强制**。路径解码是本项目最容易错的地方(Claude 有损、Pi 有损、Grok 无损),每个 adapter 的 cwd 解析必须先有测试 |
| `dispatching-parallel-agents` | 全局 | 五个适配器**互不依赖**,教科书级的并行任务 |
| `database-schema-designer` | **本项目** | 设计 launch ledger;以及读 OpenCode 那个 SQLite |
| `claude-api` | 内置 | 摘要功能要调小模型 —— model id / 定价 / 缓存 / token 计数都在里面 |
| `find-bugs` | **本项目** | 分支改动的 bug / 安全审查 |
| `verification-before-completion` | 全局 | 交付前必须实际跑过 `agents ls` 并贴出输出 |

### 贯穿全程 —— 防过度建造(最重要)

| Skill | 位置 | 用途 |
|---|---|---|
| `ponytail` | **本项目** | 强制最懒的可行方案,先质疑任务是否需要存在(YAGNI),优先标准库 |
| `ponytail-review` | **本项目** | **每个阶段结束跑一次**。只找该删的东西:重新发明的标准库、多余依赖、投机性抽象、没人用的灵活性 |

> **本项目最大的风险是过度建造。** 用户的原始需求包含 explorer + tab + 主题 + 恢复 + 摘要,
> 但护城河只有 §2 里那三件事。`ponytail-review` 是对抗这个风险的主要手段,不要跳过。

### 阶段 2 —— GUI / 设计质量(已预置)

用户反馈 UI「一眼 AI 味」,因此以下两个已装进本项目 `.claude/skills/`:

| Skill | 状态 | 用途 |
|---|---|---|
| `taste-skill` | **可直接用**(自包含) | 反 slop 前端:读需求推断设计方向,不做模板化界面;改版时先审计再动手 |
| `impeccable` | ⚠️ **POINTER,还需一步安装** | 给 agent 真正的设计词汇 + 44 条确定性检查,在 UI 发布前拦住「AI 味」 |

**`impeccable` 首次使用前必须执行**(否则调用它只会读到一张说明书):

```
npx impeccable install      # 它是个完整产品(CLI + 23 命令 + 44 检查),不是可复制的 SKILL.md
/impeccable init            # 接上设计词汇与检查;它会自己写入 .claude/ .codex/ .cursor/ .opencode/
```

> 安全提示(来自该 skill 自身):它会安装自己的 CLI 并可驱动实时浏览器。
> 执行前先看清 `npx impeccable install` 做了什么,或对其 clone 跑一次全局 `skill-scanner`。
> 源:https://github.com/pbakaus/impeccable

需要时还可以从 `~/dev-project/frontend/.claude/skills/` 和 `~/craft-project/design/.claude/skills/` 取:
`ui-ux-pro-max`(配色/风格库,**终端主题调色板用得上**)、`design-system`(三层 token)、
`frontend-design`;以及全局的 `prototype`(验证「TUI 嵌进 Electron 像不像原生」)。

### 明确不要用的

`senior-qa` 和 `webapp-testing` —— 前者是 React/Next + Jest + RTL,后者是 Playwright 测 web 应用。
**MVP 是 CLI,套上去会去搭一套用不上的前端测试设施。** 等阶段 2 有 GUI 了再考虑。

### 本地没有覆盖的空白(见 §6)

- **终端嵌入**(xterm.js + node-pty + Windows ConPTY)—— 技术风险最高,本地和网上都没有像样的 skill。
  建议边做边用 `skill-creator`(全局)攒一个。
- **Electron / Tauri 打包分发** —— 本地零覆盖。网上有 `dchuk/claude-code-tauri-skills`(39 个 Tauri v2 skill)
  但只有 30 stars,信号弱,而且技术栈未定。**优先用 context7 MCP 拉官方文档**,比来路不明的 skill 可靠。

---

## 10. 环境事实

- Windows 11 Pro for Workstations,`C:\Users\PC`
- 默认 shell 是 **Windows PowerShell 5.1**;**pwsh 7.6.4 已装**(上一轮为了 psmux 装的,保留了,是通用工具)
- git 2.51.2、node、npm(全局包在 `C:\Users\PC\AppData\Roaming\npm`)
- 5 个 agent CLI 全部已安装并可用:`claude` `codex` `opencode` `pi` `grok`
- **PowerShell 5.1 坑**:对 native exe 做 `2>&1` 重定向会把 stderr 包成 ErrorRecord 并让 `$?` 变 false(即使退出码是 0)。判断成败请用 `$LASTEXITCODE`。
- 用户当前实际负载:同时 8 个 claude 会话,每个 claude 会拉起约 15 个 MCP node 子进程 —— **单机总进程数破百**。做进程管理时要考虑这个量级。

---

## 11. 沟通提示

- 用户用中文沟通,技术术语用英文没问题
- 用户会直接指出方向错误(本轮就纠正过两次:先否掉了终端多路复用器路线,再否掉了单厂商方案)。**遇到分歧先确认产品定位再动手**
- 用户明确说过:「我觉得自己做一个这样的工具也不难」—— 请给出**诚实**的工作量判断,不要为了迎合而低估
