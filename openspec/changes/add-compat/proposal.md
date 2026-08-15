# 别人的机器：路径解析 + 诊断面板

## 为什么

到上一刀为止，**所有验证都只在开发机上做过**。而开发机恰好是：五个 agent 全装、
全部走默认路径、用户名是 ASCII、家目录没被重定向。客户机器几乎不会都这样。

代码里有 **15 处写死的路径**（`sessions/` 五个扫描器 + `harness/` 十处），
全部形如 `join(homedir(), ".claude", …)`。它们是整个产品的地基：

> **一处在别人机器上不成立，那个 agent 就静默显示成「你没有」。**
> 不是报错，是看起来一切正常 —— 这是最难查的失败模式。

## 查实的两类差异

**① 配置目录可以被环境变量改掉。** 证据来自各自的二进制与官方文档，不是猜的：

| agent | 覆盖变量 | 来源 |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | 官方文档 + `claude.exe` 的字符串 |
| codex | `CODEX_HOME` | codex 二进制里的 `$CODEX_HOME/skills` |
| opencode | `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` | `opencode.exe` 里四个都在 |
| grok | `GROK_HOME` / `XDG_CONFIG_HOME` | `grok.exe` |
| pi | **没找到** | 包和二进制里都没有 —— **没找到就不编一个** |

**② claude 的主流安装方式已经不是 npm 了。** 原生安装器自 2026-05 起是官方推荐方式，
npm「不再是主要测试和更新路径」。原生版装在 `~/.local/bin`，**没有 `package.json`**。

## 改什么

- 15 处写死路径 → 按各 agent 自己的规则解析（`src/main/paths.ts` 收口）
- **「别人的机器」测试**：在临时目录里造出各种客户机器，让真扫描器去读
- **诊断面板**：一屏说清我们找了哪儿、找到没有，可复制

## 顺带修掉的真 bug

诊断面板**第一次跑就抓到了**：`resolve.ts` 把 codex / pi 解析成了 `electron.exe`
（`process.execPath` 在 Electron 主进程里不是 node）——
也就是说这两个 agent 在应用里根本起不来。

## 不改什么

- **Windows Sandbox** —— 澄清后它的定位变了：它验的是**安装包在干净机器上能不能装能不能起**，
  不是 agent 配置兼容性（Sandbox 里没有任何 agent）。而那件事用**第二个 Windows 账户**
  更便宜：免费、可重复用、装一次 agent 能一直用。留到发版前跑一次
- **claude 原生安装的版本检测** —— 结构已经查清（版本号是 `~/.local/share/claude/versions/`
  下的目录名），但本机没有可用的原生安装可验。**没验过的不写**，下一刀做
