import { NOTED, SHORTCUTS } from "./shortcuts";
import type { ThemeColors, Theme } from "../shared/theme";

/**
 * 界面上的一个会话。
 *
 * 它可能有 PTY（正在跑 / 已停），也可能只是工作集里的一条记录还没启动。
 *
 * **刻意没有「等你输入」这个状态** —— `add-app-shell` 的规格里写过三态，
 * 但我们不解析 agent 的输出，检测不了它。留一个永远不会被赋值的状态
 * 就是界面上的又一个假承诺，等真能检测时再加回来。
 */
export interface SessionView {
  /** 稳定标识，来自工作集的主键 */
  key: string;
  agent: string;
  sessionId: string | null;
  cwd: string;
  /** 有活着的终端面板时才有 */
  paneId: string | null;
  state: "running" | "stopped" | "notStarted";
  /** 「未启动」时展示的完整命令 —— 用户该看得出点下去会执行什么 */
  command: string;
  /** 行内第二行。取不到就是 null，界面照实说，不显示成空白。 */
  label?: string | null;
  /**
   * agent 敲过铃、而你还没去看。
   *
   * 铃是终端协议自带的信号（xterm.js 的 `onBell`），**不需要解析输出**，
   * 所以它跨五个 agent 通用。切到该会话时清除。
   */
  needsAttention?: boolean;
}

/** 侧栏收藏区块的一行。 */
export interface FavoriteView {
  key: string;
  agent: string;
  sessionId: string;
  cwd: string;
  label?: string | null;
  /** 工作目录没了 —— 列出来但点不动 */
  dead: boolean;
}

/**
 * 会话行第二行显示什么 —— 一条优先级链（D-F1）。
 *
 * ```
 * 摘要（D-7，还没做） ?? agent 自带标题 ?? 开头那句用户消息
 * ```
 *
 * **不统一用首条消息**：opencode 自带的 title 是模型生成的真标题，质量高于原始首条消息。
 * 用更差的盖掉更好的，是为了「一致」牺牲用户能读到的信息。
 * （grok 也有自带摘要，但它是粗暴截断，比我们自己截还差，不进这条链。）
 */
export function labelOf(s: { nativeTitle?: string; preview?: string }): string | null {
  return s.nativeTitle?.trim() || s.preview?.trim() || null;
}

/** 会话 id 的短形式。身份用它，意义用第二行 —— 两者不是一回事。 */
export const shortId = (id: string | null): string => (id === null ? "" : id.slice(0, 6));

/** 取不到第二行时说的话。**不能留空白** —— 空白看起来像还在加载。 */
const NO_LABEL = "（没有可读的开头）";

/**
 * 转义要插进 HTML 的文本。**属性值也必须转** ——
 * Windows 路径里 `&` 是合法字符，`data-key="a&amp;b"` 不转就会读回成 `a&b`，
 * 于是按 key 的查找静默失配。同一类坑还有 U+0000，见 `model.ts` 的主键注释。
 */
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`界面缺少 #${id}`);
  return el as T;
};

/** 取路径最后一段。必须同时认反斜杠 —— Windows 路径用的是它。 */
export const folderOf = (cwd: string): string => {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : cwd;
};

function pipColor(state: SessionView["state"], c: ThemeColors): string {
  if (state === "running") return c.ansi[10]!; // brightGreen
  if (state === "notStarted") return c.ansi[11]!; // brightYellow
  return c.dim;
}

/**
 * 状态文字**说可做的动作，不说形容词**。
 *
 * 「未启动」只描述状态，不解释「为什么这里会有这一条」—— 作者本人都被它问住过。
 * 它的真实含义是：**在你的工作台上，但进程随上次退出一起没了**（D-5：成员资格与
 * 运行状态是正交的两件事）。而下面第三行那句灰字就是点下去会跑的命令。
 *
 * 「点击恢复」把这一行变成一个可执行的提议，和上方横幅的「上次留下 N 个会话」
 * 是同一件事的同一种说法 —— 以前那两处一个叫「留下」一个叫「未启动」。
 */
const stateText: Record<SessionView["state"], string> = {
  running: "工作中",
  notStarted: "点击恢复",
  stopped: "已停",
};

/** 顶栏标签页 + 侧栏工作集。两处都只渲染真实成员，不放占位数据。 */
export function renderSessions(views: SessionView[], activeKey: string | null, c: ThemeColors): void {
  $("tabs").innerHTML = views
    .filter((v) => v.paneId !== null)
    .map(
      (v) => `<button class="tab${v.key === activeKey ? " on" : ""}" data-key="${esc(v.key)}" type="button">
        <span class="dot${v.needsAttention ? " bell" : ""}" style="background:${v.needsAttention ? c.accent : pipColor(v.state, c)}"></span>
        <span class="lbl">${v.agent} · ${esc(folderOf(v.cwd))}</span>
      </button>`,
    )
    .join("");

  if (views.length === 0) {
    // 「或从历史会话里恢复一个」在一台没装 agent 的机器上是条死路 —— 那里一条会话都没有。
    // 跟着主区那块空态的分支走（`teNoAgent` 隐藏 = 装了），两处文案就不可能自相矛盾。
    const hasAgents = $("teNoAgent").hidden;
    $("tree").innerHTML = hasAgents
      ? '<div class="side-empty">工作集是空的。<br>点上面的「新建会话」，' +
        "或从「历史会话」里恢复一个 —— 加进来的会话会一直留在这里，关掉应用也不会丢。</div>"
      : '<div class="side-empty">工作集是空的。<br>先装一个 agent —— 点上面的「新建会话」，' +
        "那里有各家的官网链接。</div>";
    $("runningCount").textContent = "0 个在跑";
    return;
  }

  const groups = new Map<string, SessionView[]>();
  for (const v of views) {
    const k = folderOf(v.cwd);
    groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  $("tree").innerHTML = [...groups]
    .map(
      ([folder, items]) =>
        `<div class="grp">${esc(folder)}</div>` +
        items
          .map(
            (v) => `<button class="sess${v.key === activeKey ? " on" : ""}" data-key="${esc(v.key)}" type="button">
              <span class="row1">
                <span class="pip${v.needsAttention ? " bell" : ""}" style="background:${v.needsAttention ? c.accent : pipColor(v.state, c)}"></span>
                <span class="agent">${v.agent}</span>
                <span class="sid">${shortId(v.sessionId)}</span>
                <span class="state">${v.needsAttention ? "需要你" : stateText[v.state]}</span>
                <span class="end" data-end="${esc(v.key)}" title="结束会话：终止进程并移出工作集">✕</span>
              </span>
              <span class="sum${v.label ? "" : " none"}">${esc(v.label ?? NO_LABEL)}</span>
              ${v.state === "notStarted" ? `<span class="cmd">${esc(v.command)}</span>` : ""}
            </button>`,
          )
          .join(""),
    )
    .join("");

  $("runningCount").textContent = `${views.filter((v) => v.state === "running").length} 个在跑`;
}

/**
 * 侧栏的收藏区块。
 *
 * 与工作集正交：**收藏不等于在跑**，所以这里没有运行状态，只有「以后还要用这个」。
 * 空的时候整块隐藏 —— 一个永远空着的区块只是噪音。
 */
export function renderFavorites(list: FavoriteView[]): void {
  $("favWrap").hidden = list.length === 0;
  $("favCount").textContent = String(list.length);
  // 清空要在隐藏之后照样执行 —— 早退会把最后一条的 DOM 留在里面，
  // 区块虽然看不见，但下次再显示时先闪一下旧内容
  $("favTree").innerHTML = "";
  if (list.length === 0) return;

  $("favTree").innerHTML = list
    .map(
      (v) => `<button class="sess fav${v.dead ? " dead" : ""}" data-fav="${esc(v.key)}" type="button"
        title="${esc(v.cwd)}${v.dead ? "（工作目录已不存在）" : ""}">
        <span class="row1">
          <span class="agent">${v.agent}</span>
          <span class="sid">${shortId(v.sessionId)}</span>
          <span class="folder">${esc(folderOf(v.cwd))}</span>
          <span class="end star" data-unfav="${esc(v.key)}" title="取消收藏">★</span>
        </span>
        <span class="sum${v.label ? "" : " none"}">${esc(v.label ?? NO_LABEL)}</span>
      </button>`,
    )
    .join("");
}

/** 主题卡片里的微缩应用截面 —— 用那套主题自己的颜色，不是色块。 */
function miniPreview(c: ThemeColors): string {
  const bar = (w: number, col: string): string =>
    `<span class="m-bar" style="width:${w}%;background:${col}"></span>`;
  const dot = (col: string): string => `<span class="m-dot" style="background:${col}"></span>`;
  return `<div class="mini" style="background:${c.bg}">
    <div class="m-side" style="background:${c.chrome};border-right:1px solid ${c.line}">
      <div class="m-row">${bar(70, c.dim)}</div>
      <div class="m-row" style="background:${c.sel};border-left:1.5px solid ${c.accent};padding:1px 2px">
        ${dot(c.ansi[11]!)}${bar(52, c.fg)}
      </div>
      <div class="m-row" style="padding:1px 2px">${dot(c.dim)}${bar(44, c.dim)}</div>
      <div class="m-row">${bar(60, c.dim)}</div>
      <div class="m-row" style="padding:1px 2px">${dot(c.ansi[10]!)}${bar(48, c.fg)}</div>
    </div>
    <div class="m-main">
      <div class="m-top" style="background:${c.chrome};border-bottom:1px solid ${c.line}">
        ${dot(c.accent)}${bar(30, c.fg)}
      </div>
      <div class="m-row" style="gap:4px">${bar(14, c.ansi[6]!)}${bar(46, c.fg)}</div>
      <div class="m-row" style="gap:4px">${bar(10, c.ansi[1]!)}${bar(52, c.ansi[1]!)}</div>
      <div class="m-row" style="gap:4px">${bar(10, c.ansi[2]!)}${bar(58, c.ansi[2]!)}</div>
      <div class="m-row" style="gap:4px">${bar(8, c.ansi[11]!)}${bar(34, c.dim)}</div>
      <div class="m-row" style="gap:4px">${bar(6, c.ansi[5]!)}<span style="width:5px;height:4px;background:${c.cursor}"></span></div>
    </div>
  </div>`;
}

export function renderThemeCards(
  themes: Theme[],
  activeId: string,
  variant: "dark" | "light",
  warnings: string[],
): void {
  $("cards").innerHTML = themes
    .map((t) => {
      const c = t[variant];
      const sel = t.id === activeId;
      const sw = [c.ansi[1]!, c.ansi[2]!, c.ansi[3]!, c.ansi[4]!, c.accent]
        .map((h) => `<i style="background:${h}"></i>`)
        .join("");
      return `<button class="card" data-id="${t.id}" type="button" aria-pressed="${sel}">
        ${miniPreview(c)}
        <span class="card-foot">
          <span class="nm">${t.name}</span>
          ${sel ? '<span class="check">✓</span>' : ""}
          <span class="sw">${sw}</span>
        </span>
      </button>`;
    })
    .join("");

  const warn = $("themeWarn");
  warn.hidden = warnings.length === 0;
  warn.textContent = warnings.join(" · ");
}

/** 快捷键面板。内容来自 `SHORTCUTS` 那张表 —— 不在这里再抄一份。 */
export function renderShortcuts(): void {
  const row = (k: string, l: string, dim = false): string =>
    `<div class="krow${dim ? " dim" : ""}"><kbd>${esc(k)}</kbd><span>${esc(l)}</span></div>`;
  $("keysList").innerHTML =
    SHORTCUTS.map((s) => row(s.keys, s.label)).join("") +
    NOTED.map((s) => row(s.keys, s.label, true)).join("");
}

export function setModeButtons(mode: string): void {
  for (const b of $("modeSeg").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset["mode"] === mode));
  }
}

export function openSettings(): void {
  $("scrim").hidden = false;
  $("settingsClose").focus();
}
export function closeSettings(): void {
  $("scrim").hidden = true;
}
export const settingsOpen = (): boolean => !$("scrim").hidden;

export { $ };

// ---------------- 历史会话视图 ----------------

/** 紧凑绝对时间。刻意不做「几天前」—— 相对时间要处理时区与边界，在这里换不来什么。 */
function when(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const AGENTS = ["claude", "codex", "opencode", "pi", "grok"] as const;

export function renderAgentChips(active: Set<string>): void {
  $("histAgents").innerHTML = AGENTS.map(
    (a) =>
      `<button class="chip" type="button" data-agent="${a}" aria-pressed="${active.has(a)}">${a}</button>`,
  ).join("");
}

export function renderHistory(list: HistoryRow[], total: number, shown: number): void {
  $("histSummary").textContent = `${shown} / ${total}`;
  if (list.length === 0) {
    // 空数组与"还在加载"必须能区分开
    // **「匹配」暗示「有数据但被你筛掉了」。** 一条都没有是另一回事，
    // 而这一屏还无条件挂着五个 agent 筛选 chip，会助攻那个错觉。
    $("histList").innerHTML =
      total === 0
        ? '<div class="hist-empty">还没有任何历史会话 —— 五个 agent 都没有留下会话记录</div>'
        : '<div class="hist-empty">没有匹配的会话 —— 换个搜索词或取消 agent 筛选</div>';
    return;
  }
  $("histList").innerHTML = list
    .map(
      // 星标与"点开会话"是两个动作，所以是**两个并列的真 button** ——
      // 不是 div + role=button：真 button 自带键盘激活，自己补 keydown 只会补漏一半。
      // 它们不能嵌套（HTML 不允许 button 套 button），所以外层是 div。
      (r, i) => `<div class="hist-row${r.dead ? " dead" : ""}" data-i="${i}" data-dead="${r.dead ? 1 : 0}">
        <button class="star" type="button" data-star="${i}"
          aria-pressed="${r.starred}" title="${r.starred ? "取消收藏" : "收藏，留着以后用"}"
        >${r.starred ? "★" : "☆"}</button>
        <button class="hit" type="button"
          ${r.dead ? 'aria-disabled="true" title="工作目录已不存在，无法恢复"' : ""}>
          <span class="ag">${r.agent}</span>
          <span class="mid">
            <span class="cwd" title="${r.cwdFull}">${r.cwd}</span>
            <span class="lbl${r.label ? "" : " none"}"
              ><span class="sid">${r.sid}</span>${esc(r.label ?? NO_LABEL)}</span>
          </span>
          <span class="when">${r.when}${r.inexact ? ' <span class="flag">≈</span>' : ""}</span>
        </button>
      </div>`,
    )
    .join("");
}

export interface HistoryRow {
  agent: string;
  cwd: string;
  cwdFull: string;
  /** 第二行。取不到就是 null，显示成「（没有可读的开头）」而不是空白。 */
  label: string | null;
  /** 会话 id 的短形式 —— 身份 */
  sid: string;
  when: string;
  dead: boolean;
  inexact: boolean;
  starred: boolean;
}

/** 把一条索引记录变成可渲染的行。cwd 为 null 的会话如实标注，不编造路径。 */
export function toHistoryRow(
  s: {
    agent: string;
    sessionId: string;
    cwd: string | null;
    nativeTitle?: string;
    preview?: string;
    lastActivity: Date;
    lastActivityExact: boolean;
    cwdExists: boolean;
  },
  starred = false,
  summary?: string,
): HistoryRow {
  return {
    agent: s.agent,
    cwd: esc(s.cwd ?? "（工作目录未知）"),
    cwdFull: esc(s.cwd ?? "会话文件里读不到工作目录"),
    label: summary?.trim() || labelOf(s),
    sid: shortId(s.sessionId),
    when: when(s.lastActivity),
    dead: s.cwd === null || !s.cwdExists,
    inexact: !s.lastActivityExact,
    starred,
  };
}

export const openHistory = (): void => {
  $("histScrim").hidden = false;
  ($("histSearch") as HTMLInputElement).focus();
};
export const closeHistory = (): void => {
  $("histScrim").hidden = true;
};
export const historyOpen = (): boolean => !$("histScrim").hidden;

export const openHarness = (): void => {
  $("hxScrim").hidden = false;
  ($("hxSearch") as HTMLInputElement).focus();
};
export const closeHarness = (): void => {
  $("hxScrim").hidden = true;
};
export const harnessOpen = (): boolean => !$("hxScrim").hidden;

/**
 * 剥掉 Electron 给 IPC 拒绝加的包装文本。
 *
 * 原始形态：`Error invoking remote method 'launch:start': Error: 目录不存在：…`
 * 用户该看到的只有最后那句 —— 内部方法名和 `Error:` 前缀是实现细节，漏出去只是噪音。
 */
export function cleanIpcError(msg: string): string {
  // 先 trim 再剥前缀 —— 反过来的话，带前导空白的消息前缀就匹配不上了
  return msg
    .trim()
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:Uncaught )?Error:\s*/, "")
    .trim();
}
