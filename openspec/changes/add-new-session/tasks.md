## 1. 纯逻辑（严格 TDD）

- [x] 1.1 已测：解析器注入，成功的才列出；一个都没有时返回空列表；全可用时顺序稳定
- [x] 1.2 已测：去重、按最近活动倒序、排除 `cwdExists=false`、排除 `cwd=null`
- [x] 1.3 已测：不存在则拒绝**且断言目录未被创建**；路径是文件也拒绝；空串拒绝
- [x] 1.4 `src/main/sessions/launch.ts`，12 个测试

## 2. 主进程

- [x] 2.1 `launch:options` 一次返回可用 agent + 目录候选 + 探测耗时
- [x] 2.2 `launch:pickFolder` 调 `dialog.showOpenDialog`，取消返回 null
- [x] 2.3 `launch:start` 先 `validateTarget` 再复用 `spawnManaged`，不新增启动路径
- [x] 2.4 **实测 probeMs=311**（5 次命令解析）+ 索引扫描 ~339ms ≈ 650ms。期间显示「正在检测…」。先记录不优化

## 3. 选择器界面

- [x] 3.1 点击打开，焦点移入目录输入框
- [x] 3.2 agent 芯片单选，只列可用的；一个都没有时显示「没有检测到任何 agent」
- [x] 3.3 目录输入 + `<datalist>`（实测 158 个候选）+「浏览…」
- [x] 3.4 agent 或目录为空时「开始」按钮 disabled
- [x] 3.5 确认 → 新标签页起会话 → 选择器关闭
- [x] 3.6 失败时选择器保持打开并显示 agent 名与原因
- [x] 3.7 Esc / 点遮罩关闭

## 4. 验证

- [x] 4.1 130 个测试 / 15 个文件通过，`tsc EXIT=0`
- [x] 4.2 冒烟通过：`agents` 五个全在、`folders` 158、`probeMs` 311
- [x] 4.3 **已自动化验收**（不是人工看一眼）：冒烟走完整点击路径 ——
      开选择器 → 点 agent 芯片 → 填目录 → 按开始。结果 `tabs:2`、选择器关闭、
      终端 dump 显示 Claude Code 起在**选定的那个目录**下
- [x] 4.4 **已自动化验收**：输 `C:\根本没有这个目录` →
      `errShown:true`、`pickerStillOpen:true`、`tabs:1`（没有空白标签），
      且事后检查该目录**确实没有被创建**。
      顺带修掉了错误文案漏出 Electron IPC 包装的问题（`Error invoking remote method...`）
- [x] 4.5 codex 已验（真机起在临时目录，657 字节）；另有一条测试对「第一个非 claude 的可用 agent」通跑

## 5. 收尾

- [x] 5.1 全界面死控件审计：**只有 `btnNew` 一个**（已修）。其余未被 JS 引用的 id 都是非交互元素
- [x] 5.2 `ponytail-review` 已跑并应用。**最有价值的一条不是砍行数**：
      渲染层把 `filterSessions` 的规则**手抄了一遍** —— 主进程那份有 11 个测试守着，
      渲染层那份一个都没有，等于**让那些测试变得没意义**（被测的不是真正跑的）。
      改成直接 import。为此还得把 `makeSession` 从 `types.ts` 挪到 `scan.ts` ——
      否则渲染层 import 纯函数会被连带拉进 `node:fs`。
      已验证渲染层产物里 `node:fs` 出现 0 次。
      **未做**：把 67 行冒烟脚手架从主进程抽出去（已记为待办，价值低于风险）
