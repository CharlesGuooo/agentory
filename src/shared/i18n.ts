/**
 * 中英文案。**一份字典，两个进程共用。**
 *
 * ## 为什么主进程也用它
 *
 * 主进程本来就拥有 `settings.json`，所以它**在抛错的那一刻就知道该用哪种语言**。
 * 这样 `throw new Error(t("err.cwdMissing"))` 出去的就已经是对的语言，
 * 渲染层那条现成的 `cleanIpcError` 通路一行都不用改 —— 不需要给错误编号，
 * 也不需要渲染层拿着编号反查。给错误编号是「跨进程翻译」的标准做法，
 * 但那是给「主进程不知道用户语言」的架构准备的，我们不是。
 *
 * ## 不做通用多语言框架
 *
 * 只有中英两种，没有复数规则、没有日期本地化、没有 RTL。
 * 需要插值的地方用 `{名字}` 占位，就这一件事。
 */

export type Lang = "zh" | "en";

/**
 * 系统语言 → 我们支持的两种之一。
 *
 * 判据只有「是不是中文」：`zh` / `zh-CN` / `zh-TW` / `zh-Hans` 都算中文，
 * 其余一律英文。**不去区分简繁** —— 我们只有一份中文文案，
 * 假装支持繁体只会给出一份看着别扭的简体。
 */
export const langOfLocale = (locale: string): Lang =>
  locale.toLowerCase().startsWith("zh") ? "zh" : "en";

/** 语言设置。`system` 跟随系统，另外两种是用户显式选的。 */
export type LangSetting = "system" | Lang;

let current: Lang = "zh";

export const setLang = (l: Lang): void => {
  current = l;
};
export const getLang = (): Lang => current;

/**
 * 文案表。key 用 `区域.名字`。
 *
 * **每个 key 两种语言都必须非空** —— 有一条单测守着这件事。
 * 少一边不会是「回退到中文」，而是英文用户在英文界面里撞到一句中文，
 * 那种缺口靠肉眼是发现不了的。
 */
const DICT = {
  // ---------- 侧栏 ----------
  "side.newSession": { zh: "新建会话", en: "New session" },
  "side.history": { zh: "历史会话", en: "History" },
  "side.favorites": { zh: "收藏", en: "Favourites" },
  "side.running": { zh: "{n} 个在跑", en: "{n} running" },
  "side.resumeLeft": { zh: "上次留下 {n} 个会话", en: "{n} sessions from last time" },
  "side.resumeAll": { zh: "全部恢复", en: "Restore all" },
  "side.resumeSkip": { zh: "忽略", en: "Dismiss" },
  "side.noLabel": { zh: "（没有可读的开头）", en: "(no readable opening)" },
  "side.endSession": {
    zh: "结束会话：终止进程并移出工作集",
    en: "End session: kill the process and remove it from the workspace",
  },
  "side.unfavorite": { zh: "取消收藏", en: "Remove from favourites" },
  "side.deadCwd": { zh: "（工作目录已不存在）", en: " (working directory is gone)" },
  "side.emptyHasAgents": {
    zh: "工作集是空的。<br>点上面的「新建会话」，或从「历史会话」里恢复一个 —— 加进来的会话会一直留在这里，关掉应用也不会丢。",
    en: "The workspace is empty.<br>Use <b>New session</b> above, or restore one from <b>History</b> — whatever you add stays here, even after you quit.",
  },
  "side.emptyNoAgents": {
    zh: "工作集是空的。<br>先装一个 agent —— 点上面的「新建会话」，那里有各家的官网链接。",
    en: "The workspace is empty.<br>Install an agent first — <b>New session</b> above has links to all five.",
  },

  // ---------- 会话状态 ----------
  "state.running": { zh: "工作中", en: "Working" },
  "state.notStarted": { zh: "点击恢复", en: "Click to resume" },
  "state.stopped": { zh: "已停", en: "Stopped" },
  "state.attention": { zh: "需要你", en: "Needs you" },

  // ---------- 历史会话 ----------
  "hist.emptyNone": {
    zh: "还没有任何历史会话 —— 五个 agent 都没有留下会话记录",
    en: "No sessions yet — none of the five agents has left any history",
  },
  "hist.emptyFiltered": {
    zh: "没有匹配的会话 —— 换个搜索词或取消 agent 筛选",
    en: "Nothing matches — try another search term, or clear the agent filter",
  },
  "hist.star": { zh: "收藏，留着以后用", en: "Save to favourites" },
  "hist.deadCwd": {
    zh: "工作目录已不存在，无法恢复",
    en: "Working directory is gone — this session cannot be resumed",
  },
  "hist.cwdUnknown": { zh: "（工作目录未知）", en: "(working directory unknown)" },
  "hist.cwdUnreadable": {
    zh: "会话文件里读不到工作目录",
    en: "No working directory in the session file",
  },

  // ---------- 主区空态 ----------
  "empty.noSession": { zh: "还没有会话在跑", en: "No sessions running" },
  "empty.newHint": {
    zh: "点左上角<b>新建会话</b>开一个新的。",
    en: "Use <b>New session</b> in the top left to start one.",
  },
  "empty.histHint": {
    zh: "或者从<b>历史会话</b>里找回以前的 —— 你用过的 agent 会话都在里面，点开就接着聊。",
    en: "Or pick up an old one from <b>History</b> — every session you have had with any of the agents is in there.",
  },
  "empty.noAgent": { zh: "还没有检测到任何 agent", en: "No agents detected" },
  "empty.noAgentWhat": {
    zh: "Agentory 是 Claude Code / Codex / OpenCode / Pi / Grok 这些 CLI 的工作台，<b>本身不含 agent</b>。",
    en: "Agentory is a workbench for the Claude Code / Codex / OpenCode / Pi / Grok CLIs. It <b>does not contain an agent itself</b>.",
  },
  "empty.noAgentHow": {
    zh: "先装一个再回来 —— 点<b>新建会话</b>，那里有各家的官网链接。",
    en: "Install one and come back — <b>New session</b> has links to all five.",
  },

  // ---------- 设置 ----------
  "set.title": { zh: "设置", en: "Settings" },
  "set.heading": { zh: "设置 · 外观", en: "Settings · Appearance" },
  "set.close": { zh: "关闭", en: "Close" },
  "set.mode": { zh: "明暗", en: "Light / dark" },
  "set.modeDesc": {
    zh: "与主题相互独立 —— 换明暗不会把你选的主题换掉",
    en: "Independent of the theme — switching light/dark keeps the theme you picked",
  },
  "set.modeSystem": { zh: "跟随系统", en: "System" },
  "set.modeLight": { zh: "浅色", en: "Light" },
  "set.modeDark": { zh: "深色", en: "Dark" },
  "set.theme": { zh: "主题", en: "Theme" },

  // ---------- 设置：摘要 ----------
  "sum.label": { zh: "会话摘要", en: "Session summaries" },
  /**
   * 里面嵌着申请 key 的链接按钮。`data-url` 是**文档级委托**，
   * 所以 `innerHTML` 重建之后它照样能点 —— 不必为了保住一个链接把这段拆成三块。
   */
  "sum.what": {
    zh: '把每条会话压成一句话，填进列表第二行 —— 半年前那条会话讲的是什么，一眼能看见。<b>需要你自己的 DeepSeek API key</b>（我们不代收费，用多少是你和 DeepSeek 之间的事），在 <button class="link" type="button" data-url="https://platform.deepseek.com/api_keys">platform.deepseek.com</button> 申请。',
    en: 'Boils each session down to one sentence on the second line of every row — so you can see what a six-month-old session was about at a glance. <b>Needs your own DeepSeek API key</b> (we do not bill you; what you spend is between you and DeepSeek) — get one at <button class="link" type="button" data-url="https://platform.deepseek.com/api_keys">platform.deepseek.com</button>.',
  },
  "sum.privacy": {
    zh: "<b>生成摘要要把会话片段发给 DeepSeek</b> —— 内容会离开这台机器，所以默认关闭。发送的只有<b>首条提问</b>和<b>过滤掉工具输出后的结尾片段</b>，上限 4 KB；工具输出里藏着你的源码，一个字都不会发出去。不确定的话，先点下面的「看看会发送什么」—— 那一步是纯本地的，不需要 key。",
    en: "<b>Generating a summary sends session excerpts to DeepSeek</b> — that content leaves this machine, which is why this is off by default. Only the <b>first question</b> and a <b>tail excerpt with tool output stripped</b> are sent, capped at 4 KB; your source code lives in tool output and none of it goes out. If you are unsure, use <b>Show me what would be sent</b> below — that step is entirely local and needs no key.",
  },
  "sum.on": { zh: "已开启", en: "On" },
  "sum.off": { zh: "关闭", en: "Off" },
  "sum.save": { zh: "保存", en: "Save" },
  "sum.peek": { zh: "看看会发送什么", en: "Show me what would be sent" },
  "sum.runMine": { zh: "摘要工作集与收藏", en: "Summarise workspace + favourites" },
  "sum.runAll": { zh: "摘要全部历史", en: "Summarise all history" },
  "sum.stop": { zh: "停止", en: "Stop" },

  // ---------- 设置：字号字体 ----------
  "font.label": { zh: "字号与字体", en: "Size and font" },
  "font.hint": {
    zh: "<b>Ctrl+加号 / Ctrl+减号</b> 随时改终端字号，<b>Ctrl+0</b> 回默认 —— 和 Windows Terminal、VS Code 一致。",
    en: "<b>Ctrl+plus / Ctrl+minus</b> changes the terminal font size at any time, <b>Ctrl+0</b> resets it — same as Windows Terminal and VS Code.",
  },
  "font.ui": { zh: "界面", en: "Interface" },
  "font.uiS": { zh: "小", en: "Small" },
  "font.uiM": { zh: "标准", en: "Default" },
  "font.uiL": { zh: "大", en: "Large" },
  "font.uiXL": { zh: "特大", en: "Extra large" },
  "font.termSize": { zh: "终端字号", en: "Terminal size" },
  "font.smaller": { zh: "调小", en: "Smaller" },
  "font.bigger": { zh: "调大", en: "Bigger" },
  "font.termFamily": { zh: "终端字体", en: "Terminal font" },

  // ---------- 设置：版本 ----------
  "ver.what": {
    zh: "本机装了哪些 agent、各是什么版本。读版本是<b>纯文件读</b> —— 不会启动任何 agent 进程。查最新版会联网，<b>发出去的只有包名</b>，不含任何会话内容。<b>更新在一个你看得见的终端里跑</b>：先停掉该 agent 的会话，跑完重读版本号确认真的变了，再把会话放回来。",
    en: "Which agents are installed and at what version. Reading the installed version is a <b>pure file read</b> — no agent process is ever started. Checking for a newer one does reach the network, but <b>only a package name is sent</b>, never session content. <b>Updates run in a terminal tab you can watch</b>: that agent's sessions are stopped first, the version is re-read from disk afterwards to confirm it actually changed, and then the sessions come back.",
  },
  "ver.checkNow": { zh: "现在检查", en: "Check now" },

  // ---------- 设置：诊断 ----------
  "diag.label": { zh: "诊断", en: "Diagnostics" },
  "diag.what": {
    zh: "Agentory 靠「五个 agent 的东西在这些路径上」工作。你那边一旦不成立（配置目录被环境变量搬走、agent 是原生安装、只装了其中几个），界面会显示成「你没有」而不是报错。<b>这一屏说清我们找了哪儿、找到没有。</b>里面只有路径和数量，<b>不含任何文件内容或密钥</b>。",
    en: "Agentory works by assuming the five agents keep their files in certain places. When that is not true on your machine — a config directory moved by an environment variable, a native install, only some of them present — the UI shows &ldquo;you have none&rdquo; rather than an error. <b>This panel spells out where we looked and what we found.</b> It contains paths and counts only, <b>never file contents or credentials</b>.",
  },
  "diag.run": { zh: "收集诊断信息", en: "Collect diagnostics" },
  "diag.copy": { zh: "复制", en: "Copy" },

  // ---------- 新建会话 ----------
  "new.title": { zh: "新建会话", en: "New session" },
  "new.pickAgent": { zh: "选哪个 agent", en: "Which agent" },
  "new.pickAgentDesc": { zh: "只列出本机检测到的", en: "Only the ones detected on this machine" },
  "new.cwd": { zh: "工作目录", en: "Working directory" },
  "new.cwdDesc": {
    zh: "候选来自已有会话的真实目录",
    en: "Suggestions come from directories your existing sessions actually used",
  },
  "new.cwdPlaceholder": {
    zh: "选一个候选，或点浏览，或直接粘路径",
    en: "Pick a suggestion, browse, or paste a path",
  },
  "new.browse": { zh: "浏览…", en: "Browse…" },
  "new.go": { zh: "开始", en: "Start" },
  "new.noAgent": {
    zh: "<b>一个 agent 都没检测到。</b>Agentory 是这些 CLI 的工作台，本身不含 agent —— 先装一个再回来。",
    en: "<b>No agents detected.</b> Agentory is a workbench for these CLIs and contains no agent itself — install one and come back.",
  },
  "new.afterInstall": {
    zh: "装好之后重开 Agentory。如果你确定装了却还是检测不到，去<b>设置 · 诊断</b>看我们找了哪些路径。",
    en: "Restart Agentory after installing. If you are sure it is installed and still not detected, open <b>Settings · Diagnostics</b> to see which paths we looked in.",
  },

  // ---------- 快捷键 ----------
  "keys.title": { zh: "快捷键", en: "Keyboard shortcuts" },
  "keys.why": {
    zh: "应用级动作全部走 <b>Ctrl+Shift</b> —— 终端要用到 Ctrl+W（删词）、Ctrl+A/E（行首尾）、Ctrl+C（中断），那些键原样留给 agent。",
    en: "Every app-level action goes through <b>Ctrl+Shift</b> — the terminal needs Ctrl+W (delete word), Ctrl+A/E (line start/end) and Ctrl+C (interrupt), so those keys are left alone for the agent.",
  },

  // ---------- 历史会话弹窗 ----------
  "hist.title": { zh: "历史会话", en: "History" },
  "hist.searchPlaceholder": {
    zh: "搜索工作目录或标题…",
    en: "Search by directory or title…",
  },

  // ---------- Skills 与 MCP ----------
  "hx.title": { zh: "Skills 与 MCP", en: "Skills and MCP" },
  "hx.scope": { zh: "作用域", en: "Scope" },
  "hx.searchPlaceholder": {
    zh: "搜索 skill 或 MCP 名字…",
    en: "Search skill or MCP names…",
  },
  "theme.dirHint": {
    zh: "把自己的 JSON 放进 {dir} 即可新增",
    en: "Drop your own JSON into {dir} to add one",
  },

  // ---------- 右键菜单 ----------
  "menu.start": { zh: "启动", en: "Start" },
  "menu.switchTo": { zh: "切到这个会话", en: "Switch to this session" },
  "menu.open": { zh: "打开", en: "Open" },
  "menu.favorite": { zh: "收藏", en: "Add to favourites" },
  "menu.copySummary": { zh: "复制摘要", en: "Copy summary" },
  "menu.openInExplorer": { zh: "在资源管理器中打开", en: "Show in File Explorer" },
  "menu.copyCwd": { zh: "复制工作目录", en: "Copy working directory" },
  "menu.copySessionId": { zh: "复制 session id", en: "Copy session id" },
  "menu.endSession": { zh: "结束会话", en: "End session" },

  // ---------- 运行时状态与提示 ----------
  "term.ended": { zh: "[会话已结束，退出码 {code}]", en: "[session ended, exit code {code}]" },
  "side.restoring": { zh: "正在恢复 {done}/{total}…", en: "Restoring {done}/{total}…" },
  "hist.scanning": { zh: "正在扫描…", en: "Scanning…" },
  "hist.problems": {
    zh: "有 {n} 个来源没读出来：{list}",
    en: "{n} sources could not be read: {list}",
  },
  "hist.scanFailed": { zh: "扫描失败：{err}", en: "Scan failed: {err}" },
  "hist.restoreFailed": { zh: "恢复失败：{err}", en: "Could not resume: {err}" },
  "new.noneDetected": { zh: "没有检测到任何 agent", en: "No agents detected" },
  "new.detecting": { zh: "正在检测…", en: "Detecting…" },
  "new.detectFailed": { zh: "检测失败：{err}", en: "Detection failed: {err}" },
  "new.dupSession": {
    zh: "这个目录里已经有一个 {agent} 会话了。agent 要等会话开始后才分配 id，在那之前同一个目录的同一个 agent 只能有一条 —— 先结束那一个，或者换个目录。",
    en: "There is already a {agent} session in this directory. An agent only gets a session id once the session has started, so until then there can be just one per agent per directory — end that one first, or pick another directory.",
  },
  "new.startFailed": { zh: "启动 {agent} 失败：{err}", en: "Could not start {agent}: {err}" },
  "err.startedNotSaved": {
    zh: "会话已经起来了，但没能记进工作集：{err}",
    en: "The session started, but could not be saved to the workspace: {err}",
  },
  "err.startFailed1": { zh: "没能启动：{err}", en: "Could not start: {err}" },
  "err.startFailedN": { zh: "{n} 个没能启动：{err}", en: "{n} could not start: {err}" },
  "err.restoreFailedN": { zh: "{n} 个没能恢复：{err}", en: "{n} could not be resumed: {err}" },
  "boot.warnings": {
    zh: "启动时有 {n} 条记录读不出来：{first}",
    en: "{n} records could not be read at startup: {first}",
  },
  "boot.favPrefix": { zh: "收藏夹：{msg}", en: "Favourites: {msg}" },
  "boot.wsPrefix": { zh: "工作集：{msg}", en: "Workspace: {msg}" },

  // ---------- 摘要状态 ----------
  "sum.keyFromEnv": {
    zh: "已由 DEEPSEEK_API_KEY 环境变量提供",
    en: "Provided by the DEEPSEEK_API_KEY environment variable",
  },
  "sum.keySaved": { zh: "已保存（重新填写可覆盖）", en: "Saved (type a new one to replace it)" },
  "sum.offlineNote": {
    zh: "关闭时完全离线，第二行退回「开头那句话」",
    en: "Fully offline when off — the second line falls back to the session's opening message",
  },
  "sum.needKey": {
    zh: "还差一把 DeepSeek API key —— 填进上面那个框，下面两个按钮才能用",
    en: "Still needs a DeepSeek API key — put one in the box above to enable the buttons below",
  },
  "sum.cached": {
    zh: "已缓存 {n} 条 · {model} · 每条约 ${per}（估算，价格查证于 {date}）",
    en: "{n} cached · {model} · about ${per} each (estimate; price checked {date})",
  },
  "sum.peekEmpty": {
    zh: "工作集和收藏都是空的，先加一条会话再看",
    en: "Workspace and favourites are both empty — add a session first",
  },
  "sum.nothingToDo": { zh: "没有需要摘要的会话", en: "Nothing to summarise" },
  "sum.preparing": { zh: "准备摘要 {n} 条…", en: "Preparing {n} summaries…" },
  "sum.doneOk": { zh: "完成：成功 {ok} 条", en: "Done: {ok} succeeded" },
  "sum.doneMixed": {
    zh: "完成：成功 {ok} 条，失败 {failed} 条",
    en: "Done: {ok} succeeded, {failed} failed",
  },
  "sum.stopping": { zh: "正在停…（当前这条跑完就停）", en: "Stopping… (after the current one)" },
  "sum.progress": { zh: "正在摘要 {done}/{total}", en: "Summarising {done}/{total}" },
  "sum.progressFailed": { zh: " · 失败 {n}", en: " · {n} failed" },

  // ---------- 诊断状态 ----------
  "diag.collecting": { zh: "正在收集…", en: "Collecting…" },
  "diag.problems": { zh: "{n} 个问题", en: "{n} problems" },
  "diag.noProblems": { zh: "没发现问题", en: "Nothing wrong" },
  "diag.collectFailed": { zh: "收集失败：{err}", en: "Could not collect: {err}" },
  "diag.copied": {
    zh: "已复制，可以直接贴给维护者",
    en: "Copied — paste it straight to the maintainer",
  },

  // ---------- 版本 ----------
  "ver.noAgents": { zh: "没有检测到任何 agent", en: "No agents detected" },
  "ver.unknown": { zh: "版本未知", en: "version unknown" },
  "ver.releaseNotes": { zh: "看更新说明", en: "Release notes" },
  "ver.update": { zh: "更新", en: "Update" },
  "ver.copyHint": { zh: "点击复制", en: "Click to copy" },
  "ver.noCheckable": { zh: "本机没有可检查的 agent", en: "No agents here to check" },
  "ver.offlineNote": {
    zh: "关闭时只显示本机版本，完全离线",
    en: "When off, only the installed version is shown — fully offline",
  },
  "ver.checking": { zh: "正在查…", en: "Checking…" },
  "ver.neverChecked": { zh: "还没查过最新版", en: "Never checked for updates" },
  "ver.someUpdatable": {
    zh: "{n} 个可更新 · 上次检查 {when}",
    en: "{n} can be updated · last checked {when}",
  },
  "ver.allCurrent": { zh: "都是最新的 · 上次检查 {when}", en: "All current · last checked {when}" },
  "set.titleUpdates": {
    zh: "设置（{n} 个 agent 可更新）",
    en: "Settings ({n} agents can be updated)",
  },

  // ---------- 一键更新 ----------
  "upd.stopping": { zh: "正在停掉 {n} 个 {agent} 会话…", en: "Stopping {n} {agent} sessions…" },
  "upd.stuck": {
    zh: "（有 {n} 个会话没在 15 秒内退干净）",
    en: " ({n} sessions did not exit cleanly within 15s)",
  },
  "upd.cantStart": { zh: "起不了更新：{err}", en: "Could not start the update: {err}" },
  "upd.unknownReason": { zh: "未知原因", en: "unknown reason" },
  "upd.running": { zh: "正在更新 {agent}：{cmd}", en: "Updating {agent}: {cmd}" },
  "upd.tabLabel": { zh: "更新 {agent}", en: "Update {agent}" },
  "upd.timedOut": {
    zh: "{agent} 的更新还没结束（等超时了），版本仍是 {before} —— 看那个标签页",
    en: "The {agent} update has not finished (timed out); still at {before} — see that tab",
  },
  "upd.unchanged": {
    zh: "{agent} 的版本没变（仍是 {before}），退出码 {code} —— 看那个标签页里说了什么",
    en: "{agent}'s version did not change (still {before}), exit code {code} — see what that tab says",
  },
  "upd.restoring": {
    zh: "{agent} {before} → {now}，正在把 {n} 个会话放回来…",
    en: "{agent} {before} → {now}; restoring {n} sessions…",
  },
  "upd.done": { zh: "{agent} 已更新：{before} → {now}", en: "{agent} updated: {before} → {now}" },
  "upd.doneRestored": {
    zh: "，{back}/{n} 个会话已恢复",
    en: ", {back}/{n} sessions restored",
  },
  "upd.error": { zh: "更新 {agent} 出错：{err}", en: "Error updating {agent}: {err}" },
  "upd.unreadable": { zh: "读不到", en: "unreadable" },

  // ---------- 终端字体 ----------
  "font.default": {
    zh: "默认（Cascadia Mono → Consolas）",
    en: "Default (Cascadia Mono → Consolas)",
  },
  "font.probeNote": {
    zh: "本机可用的等宽字体 {n} 个（共探测 {total} 个候选）。列表里只有真装了的 —— 选一个没装的会静默退回，看起来像没生效。",
    en: "{n} usable monospace fonts on this machine (out of {total} probed). The list only contains fonts that are actually installed — picking a missing one silently falls back, which looks like nothing happened.",
  },

  // ---------- Skills 与 MCP ----------
  "hx.global": { zh: "全局", en: "Global" },
  "hx.noMcpSupport": { zh: "这个 agent 不支持 MCP", en: "This agent has no MCP support" },
  "hx.unreadableConfig": { zh: "配置读不出来", en: "Config could not be read" },
  "hx.unreadableDir": { zh: "目录读不出来", en: "Directory could not be read" },
  "hx.multiDef": {
    zh: "{n} 处定义 —— 我们不替你判断哪个生效",
    en: "defined in {n} places — we do not guess which one wins",
  },
  "hx.disabled": { zh: "配置里写着 enabled = false", en: "the config says enabled = false" },
  "hx.inlineSecret": {
    zh: "配置里存着明文凭证：{names}",
    en: "plaintext credentials in the config: {names}",
  },
  "hx.needsEnv": { zh: "需要环境变量：{names}", en: "needs environment variables: {names}" },
  "hx.installed": { zh: "已装：{path}\n点一下丢进系统回收站", en: "Installed: {path}\nClick to move it to the Recycle Bin" },
  "hx.copyFrom": { zh: "点一下从 {from} 复制过来", en: "Click to copy it from {from}" },
  "hx.unsupported": { zh: "不支持", en: "not supported" },
  "hx.unreadable": { zh: "读不出", en: "unreadable" },
  "hx.none": { zh: "没有", en: "none" },
  "hx.skillHint": {
    zh: "点格子装 / 卸。卸载是丢进系统回收站，可以自己恢复",
    en: "Click a cell to install or uninstall. Uninstalling moves it to the Recycle Bin, so you can put it back",
  },
  "hx.noSkills": { zh: "五个 agent 里一个 skill 都没有", en: "None of the five agents has any skills" },
  "hx.noSkillMatch": { zh: "没有匹配的 skill —— 换个搜索词", en: "No skills match — try another search term" },
  "hx.mcpReadOnly": {
    zh: "只读 —— 改配置文件要处理竞态、格式保留和四套字段互译，这一刀不做",
    en: "Read-only — editing the config files would mean races, format preservation and translating between four different schemas; not in this cut",
  },
  "hx.mcpProjectScope": {
    zh: "项目级 MCP 只有 claude 和 grok 支持，这一刀不读",
    en: "Only claude and grok support project-scoped MCP; not read in this cut",
  },
  "hx.server": { zh: "服务器", en: "Server" },
  "hx.noMcp": { zh: "一个 MCP 服务器都没有配", en: "No MCP servers configured" },
  "hx.noMcpMatch": { zh: "没有匹配的 MCP —— 换个搜索词", en: "No MCP servers match — try another search term" },
  "hx.summary": { zh: "{s} 个 skill · {m} 个 MCP", en: "{s} skills · {m} MCP servers" },
  "hx.summaryProblems": { zh: " · {n} 个问题", en: " · {n} problems" },
  "hx.loading": { zh: "正在读…", en: "Reading…" },
  "hx.loadFailed": { zh: "读不出来：{err}", en: "Could not read: {err}" },
  "hx.actionFailed": { zh: "操作失败", en: "That did not work" },
  "hx.actionFailedWith": { zh: "操作失败：{err}", en: "That did not work: {err}" },

  // ---------- 快捷键表 ----------
  "keys.new": { zh: "新建会话", en: "New session" },
  "keys.close": { zh: "结束当前会话", en: "End current session" },
  "keys.history": { zh: "历史会话", en: "History" },
  "keys.settings": { zh: "设置", en: "Settings" },
  "keys.next": { zh: "下一个会话", en: "Next session" },
  "keys.prev": { zh: "上一个会话", en: "Previous session" },
  "keys.jump": { zh: "跳到第 n 个会话", en: "Jump to session n" },
  "keys.help": { zh: "这份快捷键表", en: "This shortcut list" },
  "keys.fontUp": { zh: "终端字号放大", en: "Bigger terminal font" },
  "keys.fontDown": { zh: "终端字号缩小", en: "Smaller terminal font" },
  "keys.fontReset": { zh: "终端字号回默认", en: "Reset terminal font size" },
  "keys.esc": { zh: "关闭当前弹窗 / 菜单", en: "Close the current dialog or menu" },
  "keys.ctrlC": { zh: "中断 agent（原样交给终端）", en: "Interrupt the agent (passed straight to the terminal)" },
  "keys.ctrlW": { zh: "删一个词（原样交给终端）", en: "Delete a word (passed straight to the terminal)" },

  // ---------- 错误 ----------
  "err.missingElement": { zh: "界面缺少 #{id}", en: "The UI is missing #{id}" },
  "err.noBridge": {
    zh: "preload 桥未挂载 —— 无法起会话",
    en: "The preload bridge is not mounted — sessions cannot start",
  },

  /**
   * 三份记录文件（工作集 / 收藏 / 摘要缓存）的校验文案是同一套，共用这几个 key。
   * 它们会经由 `warnings` 显示在侧栏，所以属于「会弹给用户的错误」。
   */
  "store.notObject": { zh: "第 {i} 条不是对象", en: "Entry {i} is not an object" },
  "store.badAgent": { zh: "第 {i} 条的 agent 不认识：{v}", en: "Entry {i} has an unknown agent: {v}" },
  "store.noCwd": { zh: "第 {i} 条缺 cwd", en: "Entry {i} has no cwd" },
  "store.noSessionIdFav": {
    zh: "第 {i} 条缺 sessionId —— 收藏必须指向具体会话",
    en: "Entry {i} has no sessionId — a favourite must point at a specific session",
  },
  "store.noSessionId": { zh: "第 {i} 条缺 sessionId", en: "Entry {i} has no sessionId" },
  "store.badSessionId": { zh: "第 {i} 条的 sessionId 类型不对", en: "Entry {i} has a sessionId of the wrong type" },
  "store.noText": { zh: "第 {i} 条缺 text", en: "Entry {i} has no text" },
  "store.skipped": { zh: "跳过条目：{msg}", en: "Skipped an entry: {msg}" },

  // ---------- 主进程：启动会话 ----------
  "err.pickCwd": { zh: "请先选择工作目录", en: "Pick a working directory first" },
  "err.noDir": { zh: "目录不存在：{dir}", en: "No such directory: {dir}" },
  "err.notADir": { zh: "这个路径不是目录：{dir}", en: "That path is not a directory: {dir}" },
  "err.cwdGone": {
    zh: "工作目录不存在或不是目录：{dir}",
    en: "The working directory is missing or is not a directory: {dir}",
  },
  "err.cannotStart": { zh: "无法启动命令 {cmd}：{msg}", en: "Could not start {cmd}: {msg}" },
  "err.notOnPath": { zh: "PATH 中找不到命令：{name}", en: "Not found on PATH: {name}" },

  // ---------- 主进程：扫描问题 ----------
  "scan.failed": { zh: "[{agent}] 扫描失败：{msg}", en: "[{agent}] scan failed: {msg}" },
  "scan.sessionFailed": { zh: "[{agent}] 扫描会话失败：{msg}", en: "[{agent}] could not scan sessions: {msg}" },
  "scan.onPathButEmpty": {
    zh: "[{agent}] PATH 里有它，但会话和 skills 都是 0 —— 配置目录可能不在我们找的位置",
    en: "[{agent}] is on PATH but has zero sessions and zero skills — its config directory may not be where we look",
  },
  "scan.noConfigPaths": {
    zh: "检测到了 agent，但七条配置路径一条都不存在 —— 家目录可能被重定向了",
    en: "Agents were detected, but none of the seven config paths exists — the home directory may have been redirected",
  },
  "scan.parseFailed": { zh: "{name} 解析失败：{msg}", en: "{name} could not be parsed: {msg}" },
  "scan.sidechain": {
    zh: "{name} 是子 agent 的 transcript（isSidechain），不计为会话",
    en: "{name} is a sub-agent transcript (isSidechain), not counted as a session",
  },
  "scan.noSummaryJson": { zh: "{dir} 缺 summary.json", en: "{dir} has no summary.json" },
  "scan.summaryJsonFailed": {
    zh: "{dir}/summary.json 解析失败：{msg}",
    en: "{dir}/summary.json could not be parsed: {msg}",
  },
  "scan.emptyFile": { zh: "{name} 是空文件", en: "{name} is empty" },
  "scan.badHeader": {
    zh: "{name} 第一行不是 session header（type={type}）",
    en: "{name}: the first line is not a session header (type={type})",
  },
  "scan.sessionParseFailed": { zh: "会话 {id} 解析失败：{msg}", en: "Session {id} could not be parsed: {msg}" },

  // ---------- 主进程：harness ----------
  "hx.piNoMcp": {
    zh: "pi 不支持 MCP —— 它的文档建议改用 skills 包 CLI 工具",
    en: "pi has no MCP support — its docs suggest wrapping CLI tools in a skill instead",
  },
  "hx.mcpUnreadable": { zh: "[{agent}] MCP 配置读不动：{path}{note}", en: "[{agent}] MCP config could not be read: {path}{note}" },
  "hx.skillsUnreadable": { zh: "[{agent}] skills 目录读不动：{root}", en: "[{agent}] skills directory could not be read: {root}" },
  "hx.compatOff": {
    zh: "配置里 {list}，没有继承那边的 MCP",
    en: "the config says {list}, so those MCP servers are not inherited",
  },
  "hx.noSkillMd": { zh: "源目录里没有 SKILL.md：{src}", en: "No SKILL.md in the source directory: {src}" },
  "hx.pathEscape": { zh: "目标路径越界：{name}", en: "Target path escapes the destination: {name}" },
  "hx.alreadyThere": { zh: "已经装了：{target}", en: "Already installed: {target}" },
  "hx.copyFailed": { zh: "复制失败：{msg}", en: "Copy failed: {msg}" },
  "hx.noSuchDir": { zh: "目录不存在：{path}", en: "No such directory: {path}" },
  "hx.notASkill": {
    zh: "这不是一个 skill 目录（没有 SKILL.md）：{path}",
    en: "Not a skill directory (no SKILL.md): {path}",
  },
  "hx.outsideSkills": { zh: "不在任何已知的 skills 目录里：{path}", en: "Not inside any known skills directory: {path}" },
  "hx.recycleFailed": { zh: "丢进回收站失败：{msg}", en: "Could not move it to the Recycle Bin: {msg}" },

  // ---------- 主进程：版本与摘要 ----------
  "ver.notDetected": { zh: "没有检测到 {agent}", en: "{agent} was not detected" },
  "ver.notNpm": {
    zh: "{agent} 不是通过 npm 装的，我们不知道该怎么更新它",
    en: "{agent} was not installed through npm, so we do not know how to update it",
  },
  "sum.noContent": { zh: "模型没有返回内容", en: "The model returned nothing" },
  "sum.truncated": {
    zh: "模型写超了 {n} token 被截断，这次不采用",
    en: "The model ran past {n} tokens and was cut off — not using this one",
  },
  "sum.badJson": {
    zh: "模型没有按要求返回中英两段，这次不采用",
    en: "The model did not return both languages as asked — not using this one",
  },
  "sum.timeout": { zh: "请求超时", en: "The request timed out" },
  "sum.sessionNotFound": { zh: "找不到这条会话", en: "That session could not be found" },
  "sum.payloadFoot": {
    zh: "共 {bytes} 字节，为构造它读了 {kb} KB",
    en: "{bytes} bytes total; {kb} KB read to build it",
  },
  "sum.keyDropped": {
    zh: "之前保存的 API key 解不开了，已挪到 deepseek.key.unreadable —— 多半是 %APPDATA%\\agentory 里的 Local State 被换掉或删掉了（密文靠它解）。重填一把即可。",
    en: "The saved API key could not be decrypted and was moved to deepseek.key.unreadable — most likely Local State in %APPDATA%\\agentory was replaced or deleted (the ciphertext is bound to it). Just enter a key again.",
  },
  "sum.noKey": { zh: "还没有填 API key", en: "No API key yet" },
  "sum.alreadyRunning": { zh: "已经在跑了", en: "Already running" },
  "theme.badJson": {
    zh: "主题文件 {f} 不是合法 JSON：{msg}",
    en: "Theme file {f} is not valid JSON: {msg}",
  },

  // ---------- 设置：语言 ----------
  "set.language": { zh: "语言", en: "Language" },
  "set.langSystem": { zh: "跟随系统（{lang}）", en: "Follow system ({lang})" },
  "set.langZh": { zh: "中文", en: "中文" },
  "set.langEn": { zh: "English", en: "English" },
} as const;

export type I18nKey = keyof typeof DICT;

/** 插值：把 `{名字}` 换成 `params.名字`。没给的占位原样留着，好让漏传一眼看得见。 */
const fill = (s: string, params?: Record<string, string | number>): string =>
  params === undefined
    ? s
    : s.replace(/\{(\w+)\}/gu, (m, k: string) => (k in params ? String(params[k]) : m));

/** 取一条文案。key 是联合类型，写错在编译期就红。 */
export const t = (key: I18nKey, params?: Record<string, string | number>): string =>
  fill(DICT[key][current], params);

/** 单测用：遍历整张表，检查两种语言都在。 */
export const allEntries = (): [string, { zh: string; en: string }][] =>
  Object.entries(DICT) as [string, { zh: string; en: string }][];
