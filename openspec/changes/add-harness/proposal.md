# Harness 管理：skills 装卸 + MCP 展示

## 为什么

用户装了哪些 skill、哪个 agent 有哪个、MCP 配了什么 —— 这些今天在 agentory 里
**一个都看不到**，更谈不上管理。

**证据就在用户自己的机器上**：

```
~/.claude/scripts/move-skills.ps1      ← 用户自己写的同步脚本
~/.opencode/verify-skills.js           ← 又一个
```

四份 skills（claude / codex / pi / opencode）字节完全相同、mtime 都是
`2026-07-28 13:32:49`，是脚本一次性刷出来的，而且**不是软链** —— 改一处不会传播。

**这一刀做的，就是把那两个 PowerShell 脚本变成界面。**

`DESIGN.md §5 待定` 与 `§6 明确不做` 里都没有相关条目 —— 这是一片真空，不是被否决过的事。

## 定位：矩阵的格子就是开关

不另做一套「plugin 管理界面」。矩阵本身就是它：skill 格子可点（装 = 复制目录、
卸 = 丢系统回收站），MCP 格子只读。读和写是同一张表、同一个数据层。

## 范围是怎么定下来的

判据是**可移植性** —— 因为要做的是「一键装到另一个 agent」：

| | 能不能搬 | 支持数 | 结论 |
|---|---|---|---|
| **skills** | **完全能**：Anthropic 2025-12-18 发布 Agent Skills 规范，48 小时内 VS Code / ChatGPT / Codex CLI 全部接入，到 2026-06 约 40 个产品读同一份 `SKILL.md` | **5/5** | **完整装卸** |
| **MCP** | 半能：四套字段名要互译，还要处理密钥 | 4/5 | **只读展示** |
| **hooks** | **几乎不能**：hook 是绑在某个 agent 事件名上的 shell 命令，claude 是 JSON 事件表、codex 是 TOML 数组表 + `trusted_hash`、grok 被 `compat.*.hooks=false` 关着 | 3/5 | **不做** |

MCP 的趋势判断（调研得到）：**没死，但赢的地方不在本地** —— 它的优势是 per-user OAuth、
多租户认证、企业审计，而 token 成本是 CLI 的 32 倍（简单任务 44,026 vs 1,365）。
本地场景 CLI + Skills 在赢。用户机器上有两处旁证：pi 的 README 写着
`No MCP. Build CLI tools with READMEs (see Skills)`；grok 配置里的中文注释说
关掉 claude skills 继承是因为空跑就吃 18,647 token。

## 改什么

- 五个 agent 的 skills 与 MCP 读取（**纯文件读，零进程、零网络、零缓存**）
- 跨 agent 对照矩阵，独立弹窗
- skill 格子可点：装 = 复制目录，卸 = `shell.trashItem()` 丢系统回收站
- 作用域下拉：全局 / 工作集里的每个项目

## 不改什么

- **MCP 的装卸与开关** —— 四套字段互译 + 保格式写入 + 竞态，是整个方案最贵最危险的一段
- **hooks** —— 见上表
- **策展市场 / 从 URL 安装** —— 未来功能。它要的不是代码，是「策展 + 托管 + 版本 +
  安全扫描 + 信任」一整套供应商责任链（用户自己的全局 skill 里就有一个 `skill-scanner`）
- **读 `SKILL.md` 的 YAML frontmatter** —— 真文件里 `description:` 用 `>-` 折叠标量跨 9 行。
  **那才是 D-15「不解析多格式」真正该拦的东西**
