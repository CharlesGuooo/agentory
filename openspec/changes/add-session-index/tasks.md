> 五个扫描器互不依赖，可并行。但 **1.1 必须先做** —— 它决定 OpenCode 那个扫描器
> 是零依赖还是要引原生模块。

## 1. 前置实测

- [x] 1.1 **`node:sqlite` 可用 → OpenCode 扫描器零依赖。**
      Electron 43.4.0 / Node 24.18.1 下只读打开 824 MB 带 WAL 的库，
      `SELECT COUNT(*)` 得 166，且**写入被拒**（只读是真只读）。
      验证脚本留作 `scripts/verify-sqlite.cjs`
- [x] 1.2 **结论：必须用内容时间戳，不能用 mtime。** 已写进规格。
      mtime 恒比内容时间戳新，实测差异达 **16.5h / 59.8h / 189.7h（8 天）**；
      成因是 agent 追加 `{"type":"last-prompt"}` 这类不带时间戳的簿记记录。
      代价：尾部读 16KB，74 个文件 4 ms，可忽略
- [x] 1.3 **（计划外）Claude 的目录结构与 `DESIGN.md` §2 记载不符，已修正。**
      `<编码目录>/<uuid>/` 是会话的**附属目录**（`subagents/` `tool-results/` `workflows/`），
      递归扫描会把 74 个真会话数成 459 个。真实总数 **437** 而非 847。
      已加两条规格要求：排除子 agent transcript、以及侧链标记的识别

## 2. 共用的会话记录形状

- [x] 2.1 形状约束已落测：`cwd` 未知时是 `null`（不是空串）；`cwd` 为 null 时合并层强制 `cwdExists=false`，
      矛盾状态在这里收口，不传给下游
- [x] 2.2 `types.ts` + `scan.ts`。`scanAll(scanners)` 取扫描器数组作参数 —— 可注入即可测，且不是 D-11 警告的那种投机接口
- [x] 2.3 已测：一个 agent 抛错，其余照常返回，错误带 `[agent]` 前缀汇总；跨 agent 全局排序而非按 agent 分块

## 3. 五个扫描器（互不依赖，可并行）

- [x] 3.1 **OpenCode** 完成，7 个测试。字段映射、cwdExists、空目录变 null、空标题不产生 nativeTitle、
      库不存在返回空、扫描不改 mtime、真机 166 个会话且 >80% 有标题
- [x] 3.2 **Pi** 完成，8 个测试。含「有损目录名不影响结果」的专项断言（`ios_app_idea` 不得变成 `ios-app-idea`）
- [x] 3.3 **Claude** 完成，7 个测试。两条关键行为都落测了：
      ① 有损目录名（`local-GPU`）下产出真实的 `local_GPU` 路径；
      ② 子 agent transcript 与 `tool-results/` 不计为会话；顶层混进带 `isSidechain` 的也拦下。
      真机测试用**独立数一遍顶层 jsonl** 作对照，断言数量相等
- [x] 3.3b **（计划外）抽出 `jsonl.ts` 共用件**，13 个测试。Claude / Codex / Pi 三个都要
      「流式读头部」和「从尾部取时间戳」，rule of three 满足。
      `readHead` / `readTail` **返回实际读了多少字节** —— 这样「绝不整文件读」才有得断言
      （8MB 文件上实测只读了不到 1/50），而不是靠计时猜。
      `findJsonString` 返回**解码后**的值：JSONL 里 Windows 路径是双反斜杠，不解码会得到不存在的路径
- [x] 3.4 **Codex** 完成。测试复刻真实形态：`session_meta` 在第 1 行且**不含 cwd**，
      cwd 在后面的 `turn_context` 里；跨 `YYYY/MM/DD` 分区全部收集
- [x] 3.5 **Grok** 完成。一个会话 = 一个 UUID 目录；`cwd`/`updated_at` 取自 `summary.json`。
      专项测试断言 `session_summary` **不被采纳**（用了真实样例：带 BOM、从句中切断）

## 4. 规格里的硬要求逐条落测

- [x] 4.1 已落测（`jsonl.test.ts`）：8MB 文件上 `readHead` 实际读取 < 体积的 1/50
- [x] 4.2 已落测：Claude / Pi / Codex 各有专项用例；Claude 另有「cwd 超出头部窗口时当 null，而不是去反解目录名」
- [x] 4.3 已落测。真机上有 **35 个**这样的会话，全部保留
- [x] 4.4 已落测：Pi（坏 JSON / 空文件 / 非 session header）、Grok（缺 summary.json / 坏 JSON）
- [x] 4.5 已落测，五个扫描器各一条
- [x] 4.6 已落测：OpenCode 单独一条；真机测试再跑一遍全量扫描并比对 30 个 source 的 mtime

## 5. 真机验证

- [x] 5.1 **实测输出**（写成常驻测试而非一次性脚本）：
      437 个会话 / 339 ms —— claude 74 · codex 65 · opencode 166 · pi 12 · grok 120。
      **cwd 解析 437/437（100%）**、cwd 已消失 35、时间不精确 0、问题记录 0、原生标题仅 opencode 的 166 条
- [x] 5.2 **339 ms**，断言已常驻。超了会让测试红，而不是被悄悄容忍
- [x] 5.3 不是抽查，是**全量断言**：每条记录要么 cwd 为 null 且 `cwdExists=false`，
      要么是绝对路径且 `cwdExists` 与真实存在性一致。437 条全过 —— README §8 的验收标准达成

## 6. 收尾

- [x] 6.1 `ponytail-review` 已跑并应用。
      **判定：不抽 `AgentAdapter` 接口** —— `Scanner`（`{agent, run}`）已经是最小的共同形状，
      而且是从五个实现里长出来的；更胖的接口（`resumeCommand` / `readTranscript`）现在抽只能靠猜，
      那两个功能一行代码都还没写。
      **实际砍掉的**：`cwdExists` 的派生规则原本在五个扫描器里各写一遍 → 收进 `makeSession()`，
      从此不可能被某个扫描器写错；`HEAD_LINES` 定义了两遍 → 挪进 `jsonl.ts`
- [x] 6.2 已回写 `DESIGN.md` §2：全量报告、验收标准达成情况、以及摘要成本从 678 下修到 271
