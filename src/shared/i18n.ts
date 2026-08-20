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

  // ---------- 错误 ----------
  "err.missingElement": { zh: "界面缺少 #{id}", en: "The UI is missing #{id}" },

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
