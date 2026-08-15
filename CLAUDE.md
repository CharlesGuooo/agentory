# multi_agents_desktop_app

**开工前先完整读一遍 `docs/research-notes.md`。** 那是上一轮调研 + 本机实测的交接文档,里面的
「五个 agent 的存储格式 / resume 命令」表格是产品规格,不要重新调研。

## 一句话定位

跨 agent 的**会话索引器**(cross-agent session indexer),不是又一个终端 app。
护城河是三件事:统一会话索引、统一恢复、会话摘要。终端外壳是商品化技术,不是卖点。

## 硬性约束

- **本项目最大的风险是过度建造。** 每个阶段结束跑一次 `ponytail-review`。
- **路径解码必须 TDD。** Claude 和 Pi 的目录名是有损编码,真实 cwd 只能从会话文件内容里读。
  任何 `cwd` 输出都必须通过 `Test-Path` 才算数。
- **不许只说"应该可以"。** 交付前实际跑过,贴输出。

## 环境

Windows 11,默认 shell 是 Windows PowerShell 5.1(pwsh 7.6.4 也在)。
五个目标 agent CLI 全部已安装可用:`claude` `codex` `opencode` `pi` `grok`。

> PowerShell 5.1 坑:对 native exe 做 `2>&1` 重定向会把 stderr 包成 ErrorRecord 并让 `$?` 变 false,
> 即使退出码是 0。判断成败用 `$LASTEXITCODE`。

## Skills

`.claude/skills/` 已预置 5 个本地 skill,其余用全局的。**分阶段清单见 `docs/research-notes.md` §9**,
包括明确不要用的那两个。
