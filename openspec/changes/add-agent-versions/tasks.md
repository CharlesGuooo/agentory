> 1–3 是纯逻辑 + 真机，严格 TDD。4–6 是接线与界面，走已有的冒烟点击路径。

## 1. 版本比较（纯函数，先写测试）

- [x] 1.1 `compare.ts`，零依赖
- [x] 1.2 **`1.0.4` vs `0.2.118`** —— 逐段按字符串比会被 `118 > 4` 骗过去
- [x] 1.3 段数不同按 0 补；预发布后缀比同号正式版旧
- [x] 1.4 **解析不了一律 false，不猜** —— 误报会把用户推去做没必要的升级
- [x] 1.5 11 个测试

## 2. 已装版本（纯文件读）

- [x] 2.1 **复用 `resolveCommand`**，不另写一套查找逻辑（两套判定会分叉）
- [x] 2.2 往上走找第一个带 `version` 的 `package.json`，**不写死 npm 前缀**
- [x] 2.3 往上走的起点必须是 **`args[0] ?? exe`** —— codex / pi 的 `exe` 是 node 自己
- [x] 2.4 grok 走 `CHANGELOG.md` 首行
- [x] 2.5 「最近的那个赢」、坏 JSON 不抛、走不到磁盘根 —— 都有测试
- [x] 2.6 **实测五个全部读出来**：
      ```
      claude    2.1.220    @anthropic-ai/claude-code          ← package.json
      codex     0.147.0    @openai/codex                      ← package.json
      opencode  1.18.18    opencode-ai                        ← package.json
      pi        0.83.0     @earendil-works/pi-coding-agent    ← package.json
      grok      0.2.118    非 npm                              ← CHANGELOG.md
      ```
- [x] 2.7 **断言没起过任何 agent 进程**（见 4.1）

## 3. 最新版（网络）

- [x] 3.1 npm 四个走 `registry.npmjs.org/<pkg>/latest`
- [x] 3.2 **不能加缩略元数据 accept 头** —— scoped 包会 406（实测三个全挂）
- [x] 3.3 grok 走 `https://x.ai/cli/stable`，失败退到 GCS 那条
- [x] 3.4 `releasesUrl` 从元数据推链接，推不出返回 null，**不写死**
- [x] 3.5 复用 `deepseek.ts` 的形状：超时 + 判别联合 + **失败不抛**
- [x] 3.6 **真机实测**（离线自动跳过）：
      ```
      claude    2.1.220    → 2.1.233   ← 有新版
      codex     0.147.0    → 0.147.0
      opencode  1.18.18    → 1.18.18
      pi        0.83.0     → 0.84.2    ← 有新版
      grok      0.2.118    → 1.0.4     ← 有新版
      ```

## 4. 「绝不代劳」这条要能被证明

- [x] 4.1 记下所有 `execFileSync` 调用，断言只有 `where.exe`：
      ```
      起过的子进程：where.exe claude / where.exe codex / where.exe opencode / where.exe pi / where.exe grok
      ```
      **原来用「耗时 < 500 ms」当旁证** —— 既是间接证据，又在并发套件里量的是调度：
      单独跑 280 ms，全套件里 606 ms，翻红过一次。换成直接断言
- [x] 4.2 更新命令只进剪贴板。冒烟：`{"复制反馈":true}`
- [x] 4.3 `agents:openReleases` 只放行 GitHub releases 形状的 URL

## 5. 接线

- [x] 5.1 缓存 `versions.json`，6 小时新鲜期；**一条都没成功就不推进 `checkedAt`**，
      否则会谎称「刚查过」
- [x] 5.2 查失败保留上一次的值 —— 查不到不该让已知的东西消失
- [x] 5.3 开关默认开（`versionCheckEnabled`，沿用 `summariesEnabled` 的写法）
- [x] 5.4 启动后异步跑，不阻塞启动

## 6. 界面

- [x] 6.1 设置里的「Agent」区块
- [x] 6.2 齿轮小圆点。**推送会丢**（主进程 send 时渲染层还没监听，实测
      `齿轮有小圆点: false`）→ 改成启动时自己拉一次，推送只管「启动后才查完」
- [x] 6.3 冒烟实测：
      ```
      [smoke-ver-dot] {"齿轮有小圆点":true,"齿轮提示":"设置（3 个 agent 可更新）"}
      [smoke-ver] {"开关":"true","状态":"3 个可更新 · 上次检查 …","行数":5,
        "行":[{"agent":"claude","版本":"2.1.220 → 2.1.233","有更新命令":true,"有说明链接":true},
              {"agent":"codex","版本":"0.147.0","有更新命令":false,"有说明链接":true},
              {"agent":"opencode","版本":"1.18.18","有更新命令":false,"有说明链接":false},
              {"agent":"pi","版本":"0.83.0 → 0.84.2","有更新命令":true,"有说明链接":true},
              {"agent":"grok","版本":"0.2.118 → 1.0.4","有更新命令":true,"有说明链接":false}]}
      [smoke-ver-copy] {"复制反馈":true}
      ```
- [x] 6.4 **截图发现列对不齐**：每行各自是 flex 容器，列宽互不相干，
      「看更新说明」在五行里落到四个不同横坐标。改成写死宽度的四列 grid，
      且四个格子永远都在（空的也占位）

## 7. 文档

- [x] 7.1 `DESIGN.md` 新增 D-15
- [x] 7.2 D-8 加第三档，**并修正它的判据**（从「有没有出网」改成「出去的字节里有没有用户的东西」）
- [x] 7.3 `§5 待定` 里以 Q11 正式关闭 research-notes §6-4 那条悬空待办
- [x] 7.4 `README.md` 改写那句绝对承诺 —— 用户选了默认开，那句话不再成立

## 8. 顺带记一笔（不在本变更范围内）

- [ ] 8.1 `resolve.ts:60` 对 codex / pi 返回 `exe: process.execPath`。
      注释说逻辑来自 `probes/resolve-agent.mjs`（纯 Node 脚本，那里 `execPath` 确实是 node），
      但在 **Electron 主进程**里它是 `electron.exe`，而全仓库搜不到 `ELECTRON_RUN_AS_NODE`。
      **本变更不受影响（不起进程）**，但这可能意味着 codex / pi 在应用里根本起不来。
      值得单独验一次
