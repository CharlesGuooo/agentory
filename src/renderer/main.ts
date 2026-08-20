import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { filterSessions } from "../main/sessions/filter";
import type { AgentId, Session } from "../main/sessions/types";
import type { ThemeState } from "../main/theme/service";
import { entryCommand } from "../main/workspace/command";
import { favoriteKey, type FavoriteEntry } from "../main/favorites/model";
import { entryKey, type WorkspaceEntry } from "../main/workspace/model";
import { setupHarness } from "./harness";
import { closeMenu, menuOpen, showMenu, type MenuItem } from "./menu";
import { inTextField, resolve } from "./shortcuts";
import type { AgentoryApi } from "../preload/index";
import { setLang, t, type Lang } from "../shared/i18n";
import { applyI18n } from "./i18n-dom";
import { resolveVariant, toCssVars, toXtermTheme } from "../shared/theme";
import {
  $,
  cleanIpcError,
  closeHistory,
  closeSettings,
  esc,
  folderOf,
  historyOpen,
  labelOf,
  openHistory,
  openSettings,
  renderAgentChips,
  renderFavorites,
  renderHistory,
  renderShortcuts,
  renderSessions,
  renderThemeCards,
  setLangButtons,
  setModeButtons,
  settingsOpen,
  toHistoryRow,
  type SessionView,
} from "./shell";
import "./style.css";

const agentory = (window as unknown as { agentory?: AgentoryApi }).agentory;
const host = $("terminal");

const TERM_OPTS = {
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 13,
  cursorBlink: true,
  allowProposedApi: true,
} as const;

interface Pane {
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  /**
   * 这个面板的 ResizeObserver。**必须留着句柄** —— `el.remove()` 不会断开观察器，
   * 而它闭包里抓着 `fit` 和整个 Terminal 实例（连同它那段滚动缓冲）。
   */
  ro: ResizeObserver;
}

/** paneId → 终端。切标签页只是换显示哪一个，不销毁另一个。 */
const panes = new Map<string, Pane>();
/** 界面上的会话，**含尚未启动的工作集成员**。key 来自工作集主键。 */
const views: SessionView[] = [];
/**
 * 关掉一个面板：**断观察器、销毁终端、再摘 DOM。**
 *
 * 原来只有 `el.remove()` + `panes.delete()` —— 那两步都不释放 xterm 实例
 * （它带着整段滚动缓冲），也不断开 ResizeObserver（它的闭包抓着 fit 和整个终端）。
 * 目标负载是「同时 8 个会话」，开开关关一天下来就是几十段滚动缓冲留在内存里。
 *
 * 顺序有讲究：先 disconnect 再 dispose 再摘 DOM —— 倒过来的话摘 DOM 会触发
 * 一次 resize 回调，而那时 fit 指向的终端已经没了。
 */
function disposePane(paneId: string): void {
  const p = panes.get(paneId);
  if (!p) return;
  p.ro.disconnect();
  p.term.dispose();
  p.el.remove();
  panes.delete(paneId);
}

/** 工作目录已消失的成员 key。由主进程现算给出，不缓存。 */
const missingCwd = new Set<string>();
/**
 * 正在启动中的会话 key。**光查 `views` 不够** —— view 是在 IPC 回来之后才进去的，
 * 而 agent 起来要几秒；这几秒里再点一次，查 `views` 一样查不到，于是又起一个。
 * 用户不耐烦时的双击就落在这个窗口里。
 */
const starting = new Set<string>();
let activeKey: string | null = null;
let theme: ThemeState | null = null;

const selfCheck: Record<string, unknown> = { bridge: Boolean(agentory) };

const viewOf = (key: string): SessionView | undefined => views.find((v) => v.key === key);
const viewOfPane = (paneId: string): SessionView | undefined =>
  views.find((v) => v.paneId === paneId);

function colorsNow(): ReturnType<typeof toXtermTheme> | null {
  if (!theme) return null;
  const cur = theme.themes.find((x) => x.id === theme!.themeId) ?? theme.themes[0];
  return cur ? toXtermTheme(cur[resolveVariant(theme.mode, theme.systemPrefersDark)]) : null;
}

/** 终端字体栈的内置默认。设置里选了具体字体时排在它前面，选不中还能退回来。 */
const TERM_FONT_FALLBACK = '"Cascadia Mono", "Cascadia Code", Consolas, monospace';

/**
 * 候选等宽字体。**这只是候选，不是结论** —— 装没装、是不是真等宽、
 * CJK 是不是双宽，全部由 `probeFonts()` 当场量出来。
 *
 * 写死一串名字直接塞进下拉是错的：用户选了个本机没有的，浏览器静默退回下一个，
 * 界面上看起来「选了但没生效」—— 这个项目已经在别处栽过一次这种无声失败。
 */
const FONT_CANDIDATES = [
  "Cascadia Mono",
  "Cascadia Code",
  "Consolas",
  "Courier New",
  "Lucida Console",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "IBM Plex Mono",
  "Sarasa Mono SC",
  "Sarasa Term SC",
  "Noto Sans Mono CJK SC",
  "MS Gothic",
  "NSimSun",
];

interface FontProbe {
  name: string;
  /** 本机真的有它 */
  installed: boolean;
  /** 拉丁字符等宽 */
  mono: boolean;
}

/**
 * **这里原本还量了「CJK 是不是恰好双宽」，并在不是的字体旁边标 ⚠。那是错的，已删。**
 *
 * 实测本机 6 个等宽字体里有 4 个「CJK 非双宽」，其中包括我们自己的默认
 * `Cascadia Mono` —— 而用户拿 Cascadia Mono 跑出来的中文表格是**对齐的**。
 *
 * 原因：xterm 按**格子**排版。宽字符固定占 2 格，glyph 画在那 2 格里，
 * 窄了留白、宽了裁掉，**下一格的起点不变**。所以表格不会错位，
 * 差别只在字形看起来挤或松 —— 而那点差别不值得在默认字体旁边挂一个警告。
 *
 * 挂着的话就是 D-W1 说的那件事：**理直气壮地显示错的东西，比不显示更糟。**
 */

/**
 * 用 canvas 量字体。三件事都靠**宽度比对**，不靠任何「字体是否可用」的 API
 * （`document.fonts.check` 对本机字体不可靠）。
 *
 * 装没装：拿它和一个必然不存在的家族比 —— 宽度不同就说明它真的被用上了。
 */
function probeFonts(names: string[]): FontProbe[] {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return names.map((name) => ({ name, installed: false, mono: false }));
  const w = (text: string, family: string): number => {
    ctx.font = `16px ${family}`;
    return ctx.measureText(text).width;
  };
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

  // 一个必然不存在的家族名，用来拿到 monospace 兜底的度量
  const BOGUS = '"__agentory_no_such_font__", monospace';
  const base = w("iiiiiiiiii", BOGUS);

  return names.map((name) => {
    const q = `"${name}", monospace`;
    const installed = !near(w("iiiiiiiiii", q), base) || !near(w("WWWWWWWWWW", q), base);
    if (!installed) return { name, installed: false, mono: false };
    return { name, installed: true, mono: near(w("i", q), w("W", q)) };
  });
}

/**
 * 把字号 / 字体应用到界面与全部终端。
 *
 * 界面这边只改一个 CSS 变量 —— 六个字号档都是从它 `calc()` 出来的，
 * 所以不存在「改了五处漏一处」这回事。
 *
 * 终端这边**改完必须 `fit.fit()`**：字号变了每格的像素宽高就变了，
 * 不重算行列数的话 agent 那边仍按旧尺寸排版，画出来的框线表格会整片错位。
 */
function applyFonts(): void {
  if (!theme) return;
  document.documentElement.style.setProperty("--ui-font-scale", String(theme.uiFontScale));
  const family = theme.termFontFamily
    ? `"${theme.termFontFamily}", ${TERM_FONT_FALLBACK}`
    : TERM_FONT_FALLBACK;
  for (const p of panes.values()) {
    p.term.options.fontSize = theme.termFontSize;
    p.term.options.fontFamily = family;
    p.fit.fit();
  }
}

/**
 * 摘要:一份缓存,**一个解析点**。
 *
 * 在模块作用域,因为 `paint()` 在模块作用域 —— 原来这三个放在启动守卫块里面,
 * 渲染时够不到,于是工作集那行只能靠一次性 mutation 去追,而收藏和历史是实时查。
 * 同一个会话在同一个侧栏显示两段不同的字,根因就是这个。
 */
const summaries = new Map<string, string>();
const sumKey = (agent: string, id: string | null): string => `${agent}|${id ?? ""}`;
const summaryOf = (agent: string, id: string | null): string | undefined =>
  id === null ? undefined : summaries.get(sumKey(agent, id));

/**
 * 一行该显示哪段字。**所有读取点都必须走这里** ——
 * 渲染、右键「复制摘要」、加收藏时存下来的那份,三处只要有一处直接读 `label`,
 * 用户就会看到一段、复制到另一段。
 *
 * 持久化的 `label` 保留作兜底:工作集是同步加载的,摘要是异步的,
 * 没有它侧栏会先空一拍。**它是即时占位,不是真相。**
 */
const labelOfView = (v: {
  agent: string;
  sessionId: string | null;
  label?: string | null;
}): string | null => summaryOf(v.agent, v.sessionId) ?? v.label ?? null;

/**
 * 哪几行的摘要是展开着的。按行的 key 存。
 *
 * 不能存在 DOM 上（两个渲染函数每次都重建 `innerHTML`），也不能挂在 view 上
 * （收藏的 view 每次刷新都是新造的）。工作集和收藏共用一个集合 —— 两边的 key
 * 都是 `agent|sessionId`，同一个会话在两处展开是同一件事。
 */
const expanded = new Set<string>();

/**
 * 已经刷过文案的那个语言。
 *
 * 语言同步放在 `paint()` 里，是因为**它是「主进程状态变了」的唯一收口** ——
 * `theme = s` 在这个文件里有八处（启动、主题、明暗、字号、语言…），
 * 挨个补 `setLang` 必漏，而它们之后都会走到这里。
 * 用这个变量挡住重复：只有语言真的变了才去走那 89 个节点。
 */
let paintedLang: Lang | null = null;

function paint(): void {
  if (!theme) return;
  if (theme.lang !== paintedLang) {
    paintedLang = theme.lang;
    setLang(theme.lang);
    applyI18n();
  }
  const curTheme = theme.themes.find((x) => x.id === theme!.themeId) ?? theme.themes[0];
  if (!curTheme) return;
  const variant = resolveVariant(theme.mode, theme.systemPrefersDark);
  const colors = curTheme[variant];

  for (const p of panes.values()) p.term.options.theme = toXtermTheme(colors);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(toCssVars(colors))) root.style.setProperty(k, v);
  applyFonts();
  root.dataset["variant"] = variant;
  agentory?.setWindowOverlay(colors.chrome, colors.dim);

  // 渲染前解析摘要 —— 界面上显示的和右键复制到的必须是同一份（见 `labelOfView`）
  renderSessions(
    views.map((v) => ({ ...v, label: labelOfView(v) })),
    activeKey,
    colors,
    expanded,
  );
  // 一个终端都没有时才显示空态。有会话在跑还挂着"还没有会话在跑"是在撒谎。
  $("termEmpty").hidden = panes.size > 0;
  renderThemeCards(theme.themes, curTheme.id, variant, theme.warnings);
  // 「放进主题目录」得说清楚是哪个目录 —— 它在新机器上还不存在
  $("themeDesc").textContent = t("theme.dirHint", { dir: theme.themesDir });
  setModeButtons(theme.mode);
  setLangButtons(theme.language, theme.lang);
  document.title = `Agentory — ${curTheme.name}`;
  selfCheck["theme"] = { id: curTheme.id, variant, bg: colors.bg };
  selfCheck["workspace"] = {
    total: views.length,
    running: views.filter((v) => v.state === "running").length,
    notStarted: views.filter((v) => v.state === "notStarted").length,
  };
}

function show(key: string): void {
  activeKey = key;
  const v = viewOf(key);
  // 看了就算处理过了
  if (v) v.needsAttention = false;
  for (const [id, p] of panes) p.el.style.display = id === v?.paneId ? "block" : "none";
  const p = v?.paneId ? panes.get(v.paneId) : undefined;
  if (p) {
    p.fit.fit();
    p.term.focus();
  }
  paint();
}

const viewFromEntry = (e: WorkspaceEntry): SessionView => ({
  key: entryKey(e),
  agent: e.agent,
  sessionId: e.sessionId,
  cwd: e.cwd,
  paneId: null,
  state: "notStarted",
  command: entryCommand(e).display,
  label: e.label ?? null,
});

const entryOfView = (v: SessionView): WorkspaceEntry => ({
  agent: v.agent as AgentId,
  sessionId: v.sessionId,
  cwd: v.cwd,
  addedAt: new Date().toISOString(),
});

if (!agentory) {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p style="padding:12px;color:#e5646e">${t("err.noBridge")}</p>`,
  );
} else {
  const api = agentory;

  const dims = (): [number, number] => {
    const p = panes.get(viewOf(activeKey ?? "")?.paneId ?? "");
    return [p?.term.cols ?? 120, p?.term.rows ?? 34];
  };

  /** 给一个已经起来的会话建终端面板。新建、恢复、批量恢复都走它。 */
  function attach(view: SessionView, paneId: string): void {
    const el = document.createElement("div");
    el.className = "pane";
    host.appendChild(el);

    const c = colorsNow();
    // 新面板一出生就用当前字号 —— 不然它会先按默认尺寸排一遍版再被 applyFonts 改，
    // agent 那一瞬间收到的是错的行列数
    const term = new Terminal({
      ...TERM_OPTS,
      ...(c ? { theme: c } : {}),
      ...(theme
        ? {
            fontSize: theme.termFontSize,
            fontFamily: theme.termFontFamily
              ? `"${theme.termFontFamily}", ${TERM_FONT_FALLBACK}`
              : TERM_FONT_FALLBACK,
          }
        : {}),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const ro = new ResizeObserver(() => {
      if (viewOf(activeKey ?? "")?.paneId === paneId) fit.fit();
    });
    ro.observe(el);
    panes.set(paneId, { term, fit, el, ro });

    /**
     * agent 敲铃 = 它需要你。**用 xterm.js 的 onBell，不自己在字节流里找 ** ——
     * OSC 设置窗口标题的序列本身就以 BEL 结尾（`ESC ] 0 ; 标题 BEL`），
     * agent 每改一次标题就带一个，自己写正则会疯狂误报。
     * xterm.js 已经在逐字节解析这个流，它分得清。
     */
    term.onBell(() => {
      // 你正看着这个会话就不用提醒了
      if (view.key === activeKey && document.hasFocus()) return;
      view.needsAttention = true;
      paint();
      api.notifyBell(`${view.agent} · ${folderOf(view.cwd)}`);
    });
    term.onData((d) => api.write(paneId, d));
    term.onResize(({ cols, rows }) => api.resize(paneId, cols, rows));

    view.paneId = paneId;
    view.state = "running";
    if (!views.includes(view)) views.push(view);
    show(view.key);
    renderBanner();
  }

  // ---------- 总线 ----------
  api.onData((paneId, chunk) => panes.get(paneId)?.term.write(chunk));
  /**
   * 在等某个面板退出的人。
   *
   * 更新流程要「停掉会话 → **等它真的死了** → 再动文件」——
   * Windows 会对运行中的 exe 加镜像锁，没死透就更新会得到一个半删的包树，
   * 那正是当年 codex 事故留下缺失 shim 的机制。
   */
  const exitWaiters = new Map<string, (code: number) => void>();
  const waitExit = (paneId: string, ms = 15_000): Promise<number | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        exitWaiters.delete(paneId);
        resolve(null); // 超时。调用方要把 null 当「没等到」而不是「成功了」
      }, ms);
      exitWaiters.set(paneId, (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

  api.onExit((paneId, info) => {
    const v = viewOfPane(paneId);
    // 进程退出**不改变成员资格**（D-5）—— 只改运行状态
    if (v) v.state = "stopped";
    panes
      .get(paneId)
      ?.term.writeln(`\r\n\x1b[90m${t("term.ended", { code: info.exitCode })}\x1b[0m`);
    exitWaiters.get(paneId)?.(info.exitCode);
    exitWaiters.delete(paneId);
    paint();
  });
  api.onWorkspaceStarted(({ entry, spawned }) => {
    attach(viewOf(entryKey(entry)) ?? viewFromEntry(entry), spawned.id);
  });
  api.onWorkspaceProgress((done, total) => {
    $("resumeNote").textContent = done < total ? t("side.restoring", { done, total }) : "";
  });

  void api.themeState().then((s) => {
    theme = s;
    paint();
  });
  api.onThemeChanged((s) => {
    theme = s;
    paint();
  });

  // ---------- 设置 ----------
  $("gear").addEventListener("click", () => {
    openSettings();
    renderFontRow();
    void loadSumState();
    void loadVerState();
    // 看过就不用再提醒了
    $("gear").classList.remove("has-update");
  });
  $("settingsClose").addEventListener("click", closeSettings);
  $("scrim").addEventListener("click", (e) => {
    if (e.target === $("scrim")) closeSettings();
  });
  $("cards").addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".card")?.dataset["id"];
    if (id) {
      void api.setTheme({ themeId: id }).then((s) => {
        theme = s;
        paint();
      });
    }
  });
  $("modeSeg").addEventListener("click", (e) => {
    const m = (e.target as HTMLElement).dataset["mode"];
    if (m === "system" || m === "light" || m === "dark") {
      void api.setTheme({ mode: m }).then((s) => {
        theme = s;
        paint();
      });
    }
  });
  $("langSeg").addEventListener("click", (e) => {
    const l = (e.target as HTMLElement).dataset["lang"];
    if (l === "system" || l === "zh" || l === "en") {
      void api.setTheme({ language: l }).then((s) => {
        theme = s;
        // `paint()` 自己会发现 `lang` 变了并重刷全部文案（见 `paintedLang`）
        paint();
        refreshFavorites();
        if (historyOpen()) refreshHistory();
      });
    }
  });

  // ---------- 字号与字体 ----------
  $("uiFontSeg").addEventListener("click", (e) => {
    const v = (e.target as HTMLElement).dataset["uiscale"];
    if (v) setUiFontScale(Number(v));
  });
  $("termFontDown").addEventListener("click", () => setTermFontSize((theme?.termFontSize ?? 13) - 1));
  $("termFontUp").addEventListener("click", () => setTermFontSize((theme?.termFontSize ?? 13) + 1));
  $("termFontFamily").addEventListener("change", () => {
    const v = ($("termFontFamily") as HTMLSelectElement).value;
    setTermFontFamily(v === "" ? null : v);
  });

  // ---------- 收藏夹 ----------
  /** 收藏与工作集**正交** —— 收藏不等于在跑，两份记录各自独立（同 D-5 的分法）。 */
  let favorites: FavoriteEntry[] = [];
  const favMissing = new Set<string>();

  const isStarred = (s: Session): boolean =>
    favorites.some((f) => favoriteKey(f) === favoriteKey(s));

  function refreshFavorites(): void {
    renderFavorites(
      favorites.map((f) => ({
        key: favoriteKey(f),
        agent: f.agent,
        sessionId: f.sessionId,
        cwd: f.cwd,
        label: labelOfView(f),
        dead: favMissing.has(favoriteKey(f)),
      })),
      expanded,
    );
  }

  async function toggleStar(s: Session | undefined): Promise<void> {
    if (!s || s.cwd === null) return;
    const label = labelOf(s);
    const fav = isStarred(s)
      ? await api.favoriteRemove(s.agent, s.sessionId)
      : await api.favoriteAdd({
          agent: s.agent,
          sessionId: s.sessionId,
          cwd: s.cwd,
          ...(label === null ? {} : { label }),
          addedAt: new Date().toISOString(),
        });
    favorites = fav.sessions;
    // 刚收藏的条目目录一定还在（是从活着的历史行点的），不必再算一次
    refreshFavorites();
    refreshHistory();
  }

  // ---------- 历史会话 ----------
  let allSessions: Session[] = [];
  let shown: Session[] = [];
  const pickedAgents = new Set<string>();

  function refreshHistory(): void {
    // 用主进程侧那个有测试守着的纯函数 —— 手抄一份规则会让那些测试变得没意义
    shown = filterSessions(allSessions, {
      text: ($("histSearch") as HTMLInputElement).value,
      agents: [...pickedAgents] as AgentId[],
    });
    renderHistory(
      shown.map((s) => toHistoryRow(s, isStarred(s), summaryOf(s.agent, s.sessionId))),
      allSessions.length,
      shown.length,
    );
    renderAgentChips(pickedAgents);
  }

  $("btnHistory").addEventListener("click", () => {
    openHistory();
    $("histList").innerHTML = `<div class="hist-empty">${t("hist.scanning")}</div>`;
    void api
      .listSessions()
      .then((r) => {
        allSessions = r.sessions;
        $("historyCount").textContent = String(allSessions.length);
        /**
         * **读不动的来源必须说出来。**
         *
         * 这里原本只取 `r.sessions`，`r.problems` 直接丢掉。后果不是少一行提示：
         * 「opencode 的库被别的进程锁着」那次，166 条会话整块消失，
         * 而界面上的表现只是计数从 437 变成 271 —— 用户没有任何理由怀疑
         * 自己看到的不是全部。那次是靠并发跑测试碰巧撞出来的。
         */
        $("histProblems").hidden = r.problems.length === 0;
        $("histProblems").textContent =
          r.problems.length === 0 ? "" : t("hist.problems", { n: r.problems.length, list: r.problems.join("；") });
        refreshHistory();
      })
      // 不接住的话，弹窗会永远停在「正在扫描…」
      .catch((e: unknown) => {
        $("histList").innerHTML = `<div class="hist-empty">${esc(t("hist.scanFailed", { err: cleanIpcError(String(e)) }))}</div>`;
      });
  });
  $("histClose").addEventListener("click", closeHistory);
  $("histScrim").addEventListener("click", (e) => {
    if (e.target === $("histScrim")) closeHistory();
  });
  $("histSearch").addEventListener("input", refreshHistory);
  $("histAgents").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).dataset["agent"];
    if (!a) return;
    if (pickedAgents.has(a)) pickedAgents.delete(a);
    else pickedAgents.add(a);
    refreshHistory();
  });
  $("histList").addEventListener("click", (e) => {
    const tgt = e.target as HTMLElement;

    // 星标与"点开会话"是两个动作。收藏不该顺手把会话起起来 —— 这也是
    // 它们在 DOM 上是两个可点区域而不是一个的原因。
    const starIdx = tgt.closest<HTMLElement>(".star")?.dataset["star"];
    if (starIdx !== undefined) {
      e.stopPropagation();
      void toggleStar(shown[Number(starIdx)]);
      return;
    }

    const row = tgt.closest<HTMLElement>(".hist-row");
    if (!row || row.dataset["dead"] === "1") return;
    const s = shown[Number(row.dataset["i"])];
    if (!s || s.cwd === null) return;
    const cwd = s.cwd;
    // 从历史恢复是**显式动作** → 加入工作集（D-5）
    const label = labelOf(s);
    const entry: WorkspaceEntry = {
      agent: s.agent,
      sessionId: s.sessionId,
      cwd,
      ...(label === null ? {} : { label }),
      addedAt: new Date().toISOString(),
    };

    /**
     * **已经开着的会话，切过去，不再起第二个。**
     *
     * 之前这里无条件 resume，而 `attach` 的去重是 `views.includes(view)`（**引用相等**），
     * 每次都新造一个 view 对象 → 必然再 push 一个同 key 的。后果不是「多一个 tab」，
     * 是**两个 agent 进程 `--resume` 同一个会话 id、同时往同一个 transcript 追加** ——
     * 而那些会话文件是这个产品的全部地基。
     *
     * 判断必须在 `resumeSession` **之前**：事后去重的话第二个 pty 已经起来了。
     * 用 `activate` 而不是 `show`，因为「已在工作集但还没启动」也要走到 —— 那种情况该起它。
     *
     * 冒烟 `AGENTORY_SMOKE_FROM_HISTORY=dup` 复现过：两个 tab 的 data-key 完全相同。
     */
    const key = entryKey(entry);
    if (starting.has(key)) return;
    const open = viewOf(key);
    if (open) {
      closeHistory();
      activate(key);
      return;
    }

    starting.add(key);
    const [cols, rows] = dims();
    void api
      .resumeSession(s, cols, rows)
      .then(async (r) => {
        closeHistory();
        attach(viewFromEntry(entry), r.id);
        await persist(entry);
      })
      .catch((err: Error) => {
        $("histList").insertAdjacentHTML(
          "afterbegin",
          `<div class="hist-empty">${esc(t("hist.restoreFailed", { err: cleanIpcError(err.message) }))}</div>`,
        );
      })
      // 失败也要放开，否则这条会话在本次运行里永远起不来了
      .finally(() => starting.delete(key));
  });

  // ---------- 新建会话 ----------
  let pickedAgent: AgentId | null = null;
  const closeNew = (): void => {
    $("newScrim").hidden = true;
  };
  const newOpen = (): boolean => !$("newScrim").hidden;
  const showNewError = (msg: string | null): void => {
    const el = $("newError");
    el.hidden = msg === null;
    el.textContent = msg ?? "";
  };
  const syncNewGo = (): void => {
    ($("newGo") as HTMLButtonElement).disabled =
      pickedAgent === null || ($("newCwd") as HTMLInputElement).value.trim().length === 0;
  };
  const paintAgentChips = (agents: string[]): void => {
    $("newAgents").innerHTML =
      agents.length === 0
        ? `<span class="desc">${t("new.noneDetected")}</span>`
        : agents
            .map(
              (a) =>
                `<button class="chip" type="button" data-agent="${a}" aria-pressed="${a === pickedAgent}">${a}</button>`,
            )
            .join("");
  };

  $("btnNew").addEventListener("click", () => {
    $("newScrim").hidden = false;
    showNewError(null);
    pickedAgent = null;
    $("newAgents").innerHTML = `<span class="desc">${t("new.detecting")}</span>`;
    syncNewGo();
    void api
      .launchOptions()
      .then((o) => {
        paintAgentChips(o.agents);
        $("newCwdList").innerHTML = o.folders
          .map((f) => `<option value="${esc(f)}"></option>`)
          .join("");
        selfCheck["launch"] = {
          agents: o.agents,
          folders: o.folders.length,
          probeMs: Math.round(o.probeMs),
        };
        // **一个都没有时必须说清原因并给出路** —— 否则开始键永远灰着，
        // 界面从头到尾不解释为什么，用户只能猜
        $("newNoAgent").hidden = o.agents.length > 0;
        ($("newCwd") as HTMLInputElement).focus();
        syncNewGo();
      })
      // 不接住的话，弹窗会永远停在「正在检测…」
      .catch((e: unknown) => {
        $("newAgents").innerHTML = `<span class="desc">${esc(t("new.detectFailed", { err: cleanIpcError(String(e)) }))}</span>`;
      });
  });
  /**
   * 外链一律走这一个文档级委托。
   *
   * 原来它只挂在 `#newNoAgent` 上，于是往别处（比如设置里的摘要说明）加一个
   * `data-url` 按钮，**点了会毫无反应** —— 一个看着能点、实际什么都不做的控件，
   * 正是这个项目反复抓到的那一类。挂在 document 上就不存在「放错容器」这回事。
   *
   * 安全边界不在这里：`api.openUrl` 走 preload，那里只放行 https。
   */
  document.addEventListener("click", (e) => {
    const u = (e.target as HTMLElement).closest<HTMLElement>("[data-url]")?.dataset["url"];
    if (u) api.openUrl(u);
  });
  $("newClose").addEventListener("click", closeNew);
  $("newScrim").addEventListener("click", (e) => {
    if (e.target === $("newScrim")) closeNew();
  });
  $("newAgents").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).dataset["agent"];
    if (!a) return;
    pickedAgent = a as AgentId;
    for (const b of $("newAgents").querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset["agent"] === a));
    }
    syncNewGo();
  });
  $("newCwd").addEventListener("input", () => {
    showNewError(null);
    syncNewGo();
  });
  $("newBrowse").addEventListener("click", () => {
    void api.pickFolder().then((dir) => {
      if (dir === null) return;
      ($("newCwd") as HTMLInputElement).value = dir;
      showNewError(null);
      syncNewGo();
    });
  });
  $("newGo").addEventListener("click", () => {
    const cwd = ($("newCwd") as HTMLInputElement).value.trim();
    if (pickedAgent === null || !cwd) return;
    const agent = pickedAgent;

    /**
     * **同一个目录 + 同一个 agent，工作集里只能有一条没有 id 的会话。**
     *
     * 主键在没有 id 时退化成 `agent|cwd:<目录>`（`workspace/model.ts` 有说明），
     * 而新建的会话**永远拿不到 id**（id 由 agent 写进它自己的会话文件，我们不回填）。
     * 所以在同一个目录里再起一个同样的 agent，两个 view 的 key 完全相同，
     * 而 `viewOf` 返回的是第一个 —— 后果不是「多一行」：
     *
     *   · 第二个标签页点不开（`show(key)` 永远切到第一个）
     *   · ✕ 结束的是第一个
     *   · 第二个的 pty 成为界面上够不着的孤儿，只有退出应用才收得走
     *
     * 也就是说这条路今天**本来就是坏的**，只是坏得无声。挡住它并说清原因，
     * 严格优于让用户开出一个点不开也关不掉的会话。
     * （真要支持同目录多会话，得给工作集条目一个稳定的本地 id —— 那是另一件事。）
     */
    if (viewOf(entryKey({ agent, sessionId: null, cwd, addedAt: "" }))) {
      showNewError(
        t("new.dupSession", { agent }),
      );
      return;
    }

    const [cols, rows] = dims();
    void api
      .startSession(agent, cwd, cols, rows)
      .then(async (r) => {
        closeNew();
        // 新建的会话拿不到 id —— id 是 agent 自己生成写进会话文件的（D-W3b）
        const entry: WorkspaceEntry = {
          agent,
          sessionId: null,
          cwd,
          addedAt: new Date().toISOString(),
        };
        attach(viewFromEntry(entry), r.id);
        await persist(entry);
      })
      .catch((err: Error) => showNewError(t("new.startFailed", { agent, err: cleanIpcError(err.message) })));
  });

  // ---------- 工作集：结束 / 启动未启动的 ----------
  async function endSession(key: string): Promise<void> {
    const v = viewOf(key);
    if (!v) return;
    // 「结束会话」= 杀进程 + 移出工作集（DESIGN.md Q7 定案）
    if (v.paneId !== null) {
      api.kill(v.paneId);
      disposePane(v.paneId);
    }
    await api.workspaceRemove(v.agent as AgentId, v.sessionId, v.cwd);
    views.splice(views.indexOf(v), 1);
    if (activeKey === key) activeKey = views.find((x) => x.paneId !== null)?.key ?? null;
    if (activeKey !== null) show(activeKey);
    else paint();
  }

  /**
   * 侧栏的报错位。传 `null` 清空。
   *
   * 在它之前，侧栏点击这条路径**没有任何报错出口**：`restoreSerially` 老老实实
   * 带回了每条的 `{ok, error}`，`resumeGo` 那条路也确实读了（写进 `#resumeNote`），
   * 唯独侧栏和收藏区把整个返回值 `void` 掉了。失败时用户看到的是：点一下，
   * 什么都没发生 —— 那正是 U+0000 那次的形状（四个交互全是死的却一个错都不报）。
   */
  const sideNote = (msg: string | null): void => {
    $("sideNote").textContent = msg ?? "";
    $("sideNote").hidden = msg === null;
  };

  /**
   * 把会话记进工作集。**必须在 `attach` 之后调，而且不能让它的失败冒泡。**
   *
   * 原本是 `await api.workspaceAdd(entry); attach(...)` —— 顺序反了：
   * 进程在 `startSession`/`resumeSession` 时就已经起来了，落盘失败
   * （盘满、AppData 被杀软锁住、workspace.json 被设成只读、漫游配置额度满）
   * 会让 `attach` 永远不执行，于是那个 agent 进程连同它的一堆 MCP 子进程
   * **没有面板、没有 view、没有标签页**，只有退出应用才收得走。
   * 而界面显示的是「启动失败」—— 一句假话。
   *
   * 面板是用户唯一能控制那个进程的把手，所以它优先于持久化。
   */
  const persist = async (entry: WorkspaceEntry): Promise<void> => {
    try {
      await api.workspaceAdd(entry);
    } catch (e) {
      sideNote(t("err.startedNotSaved", { err: cleanIpcError((e as Error).message) }));
    }
  };

  /** 批量恢复的结果：失败的必须说出来。成功则清掉上一条错。 */
  const reportRestore = (outcomes: { ok: boolean; error?: string }[]): void => {
    const bad = outcomes.filter((o) => !o.ok);
    sideNote(
      bad.length === 0
        ? null
        : bad.length === 1
          ? t("err.startFailed1", { err: cleanIpcError(bad[0]!.error ?? "") })
          : t("err.startFailedN", { n: bad.length, err: cleanIpcError(bad[0]!.error ?? "") }),
    );
  };

  function activate(key: string): void {
    const v = viewOf(key);
    if (!v) return;
    if (v.paneId !== null) {
      show(key);
      return;
    }
    // 「未启动」：点一下才真起（D-W3，D-12 的精神实现）
    //
    // 在途标志不能省：agent 起来要几秒，这几秒里 `v.paneId` 还是 null，
    // 再点一次就又起一个 —— 而第二个进程界面上没有任何句柄，✕ 杀不掉它。
    // 冒烟 `START_MEMBER=double` 复现过：主进程 2 个 pty，界面说 1 个在跑。
    if (starting.has(key)) return;
    starting.add(key);
    sideNote(null);
    const [cols, rows] = dims();
    void api
      .workspaceRestoreAll([entryOfView(v)], cols, rows)
      .then(reportRestore)
      .catch((e: Error) => sideNote(cleanIpcError(e.message)))
      .finally(() => starting.delete(key));
  }

  $("tabs").addEventListener("click", (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>(".tab")?.dataset["key"];
    if (k) show(k);
  });
  /**
   * 点摘要 = 就地展开/收起，**绝不是启动会话**。
   *
   * `.sess` 整行是一个 `<button>`，`.sum` 在它里面 —— 不 `stopPropagation` 就会掉进
   * 下面那句 `activate(k)`。改之前实测过：点一下摘要，pty 从 0 变成 1、
   * 标签页从 0 变成 1。**「想读一眼摘要，起了一个 agent 进程」。**
   */
  const toggleExpand = (key: string): void => {
    if (!expanded.delete(key)) expanded.add(key);
    paint();
    refreshFavorites();
  };

  $("tree").addEventListener("click", (e) => {
    const tgt = e.target as HTMLElement;
    const expKey = tgt.dataset["expand"];
    if (expKey !== undefined) {
      e.stopPropagation();
      toggleExpand(expKey);
      return;
    }
    const endKey = tgt.dataset["end"];
    if (endKey) {
      e.stopPropagation();
      void endSession(endKey);
      return;
    }
    const k = tgt.closest<HTMLElement>(".sess")?.dataset["key"];
    if (k) activate(k);
  });

  // ---------- 重启恢复：侧栏横幅 ----------
  /**
   * 此前这里是一个**阻塞式弹窗**：每次开应用都先拦住你，列出成员让你勾选。
   *
   * 它和侧栏重复了 —— `add-workspace` 之后，侧栏本来就把「未启动」的成员连同
   * **将要执行的完整命令**列了出来，点一行就起。弹窗多出来的只有勾选框，
   * 而那件事侧栏做得更好（能看到命令、能看到第二行摘要）。
   *
   * D-12 的确认点没有丢：**不点就不花 token**。变的只是它不再挡住整个应用。
   */
  const restorable = (): SessionView[] => views.filter((v) => v.state === "notStarted");
  const canRestore = (v: SessionView): boolean => !missingCwd.has(v.key);

  function renderBanner(): void {
    const n = restorable().filter(canRestore).length;
    const bar = $("resumeBar");
    bar.hidden = n === 0 || bannerDismissed;
    if (!bar.hidden) $("resumeText").textContent = t("side.resumeLeft", { n });
  }
  let bannerDismissed = false;

  $("resumeGo").addEventListener("click", () => {
    const picked = restorable().filter(canRestore);
    const [cols, rows] = dims();
    ($("resumeGo") as HTMLButtonElement).disabled = true;
    void api.workspaceRestoreAll(picked.map(entryOfView), cols, rows).then((outcomes) => {
      const bad = outcomes.filter((o) => !o.ok);
      ($("resumeGo") as HTMLButtonElement).disabled = false;
      // 失败的说清楚，不静默消失
      $("resumeNote").textContent =
        bad.length === 0 ? "" : t("err.restoreFailedN", { n: bad.length, err: cleanIpcError(bad[0]!.error ?? "") });
      bannerDismissed = bad.length === 0;
      renderBanner();
    });
  });
  $("resumeSkip").addEventListener("click", () => {
    bannerDismissed = true;
    renderBanner();
  });

  // ---------- 摘要（D-7 第 1 层）----------
  /**
   * 摘要是 `labelOf` 优先级链的第一位：摘要 ?? agent 自带标题 ?? 开头那句。
   *
   * 这里只负责**把缓存填上**，谁该显示哪段字由 `labelOfView` 在渲染时决定。
   * （原来这句注释写的是「界面代码不用改，链早就写好了」—— 那已经不成立了：
   * 当时是靠一次性 mutation 把摘要塞进 `v.label`，那正是同一个会话在侧栏
   * 显示两段字的根因。）
   */
  async function refreshSummaries(): Promise<void> {
    for (const s of await api.summaryAll()) summaries.set(sumKey(s.agent, s.sessionId), s.text);
    // 这里原来还有一行 `for (const v of views) v.label = …` —— **删掉了**。
    // 那是一次性 mutation，只覆盖那一刻已存在的 view；之后 `viewFromEntry` 造出来的
    // （恢复、更新后重启、从收藏拉进来）永远等不到摘要。现在渲染时统一走 `labelOfView`。
    paint();
    refreshFavorites();
    if (historyOpen()) refreshHistory();
  }

  function renderSumState(st: Awaited<ReturnType<typeof api.summaryState>>): void {
    const on = st.enabled;
    ($("sumToggle") as HTMLButtonElement).textContent = on ? t("sum.on") : t("sum.off");
    $("sumToggle").setAttribute("aria-pressed", String(on));
    $("sumKeyRow").hidden = !on;
    /**
     * **没有 key 时按钮要灰掉，不是消失。**
     *
     * 原来是 `hidden = !on || !st.hasKey` —— 整排按钮直接不存在，而且不说为什么。
     * 用户打开开关，看到一个输入框和一行价钱，然后什么都没有。
     *
     * 照 `verCheck` 那个先例：**按钮留在原地并置 `disabled`，
     * 相邻的 `.desc` 给原因，而且原因排在三元表达式的第一支**。
     *
     * 「看看会发送什么」**不禁用** —— 它是纯本地拼载荷，不出网、不需要 key，
     * 而且恰恰是还没拿到 key 的人最该先点的那一个（先看清要发什么，再决定要不要办 key）。
     */
    $("sumActions").hidden = !on;
    for (const id of ["sumRunMine", "sumRunAll"]) {
      ($(id) as HTMLButtonElement).disabled = !st.hasKey;
    }
    ($("sumKey") as HTMLInputElement).disabled = st.keyFromEnv;
    ($("sumKey") as HTMLInputElement).placeholder = st.keyFromEnv
      ? t("sum.keyFromEnv")
      : st.hasKey
        ? t("sum.keySaved")
        : "DeepSeek API key";
    // 费用写在**常驻**状态行里，不写在点完之后的进度行里 ——
    // 点完才告诉你要花多少，那不叫知情。单条价钱不需要知道总数，也就不会被异步结果盖掉。
    // 估算依据：实测载荷约 1200 输入 token，输出 50。2026-08-16 起改峰谷计费，故标日期。
    const per = (1200 * st.price.in + 50 * st.price.out) / 1e6;
    /**
     * 顺序照 `verCheck`：**挡住你的那个原因排在最前面**，它压过「开着还是关着」那句话。
     *
     * `keyDropped` 排在**最前**，连 `!on` 都压过去 —— 密钥是不管开关开着关着都会
     * 被读、被清掉的（`state()` 无条件调 `readKey()`）。如果只在开关打开时才说，
     * 一个关着摘要的用户会在某天打开它时发现 key 没了，而现场早就没了。
     */
    $("sumStatus").classList.toggle("warn", st.keyDropped);
    $("sumStatus").textContent = st.keyDropped
      ? t("sum.keyDropped")
      : !on
        ? t("sum.offlineNote")
        : !st.hasKey
          ? t("sum.needKey")
          : t("sum.cached", { n: st.cached, model: st.model, per: per.toFixed(4), date: st.price.checkedAt });
  }

  const loadSumState = (): Promise<void> => api.summaryState().then(renderSumState);

  $("sumToggle").addEventListener("click", () => {
    const on = $("sumToggle").getAttribute("aria-pressed") === "true";
    void api.summarySetEnabled(!on).then(renderSumState);
  });
  $("sumKeySave").addEventListener("click", () => {
    const box = $("sumKey") as HTMLInputElement;
    void api.summarySetKey(box.value).then((st) => {
      box.value = "";
      renderSumState(st);
    });
  });

  /** 拿**你自己的**一条会话渲染真实请求体。没有比这更直接的证明方式。 */
  $("sumPeek").addEventListener("click", () => {
    // 再点一次收起来。展开了就没法关掉，那个按钮就等于只能按一次
    if (!$("sumPeekBox").hidden) {
      $("sumPeekBox").hidden = true;
      return;
    }
    const v = views.find((x) => x.sessionId !== null) ?? null;
    const f = favorites[0];
    const ref = v ? { agent: v.agent as AgentId, sessionId: v.sessionId! } : f ? { agent: f.agent, sessionId: f.sessionId } : null;
    if (!ref) {
      $("sumPeekBox").textContent = t("sum.peekEmpty");
      $("sumPeekBox").hidden = false;
      return;
    }
    void api.summaryPreview(ref.agent, ref.sessionId).then((text) => {
      $("sumPeekBox").textContent = text;
      $("sumPeekBox").hidden = false;
    });
  });

  function runSummaries(refs: { agent: AgentId; sessionId: string }[]): void {
    if (refs.length === 0) {
      $("sumProgress").textContent = t("sum.nothingToDo");
      return;
    }
    $("sumProgress").textContent = t("sum.preparing", { n: refs.length });
    $("sumStop").hidden = false;
    void api.summaryRun(refs).then((r) => {
      $("sumStop").hidden = true;
      $("sumProgress").textContent = r.error
        ? r.error
        : r.failed ? t("sum.doneMixed", { ok: r.ok, failed: r.failed }) : t("sum.doneOk", { ok: r.ok });
      void refreshSummaries();
      void loadSumState();
    });
  }

  // 全部历史是几百条串行，跑十几分钟且在花钱 —— 必须能中途叫停
  $("sumStop").addEventListener("click", () => {
    $("sumProgress").textContent = t("sum.stopping");
    void api.summaryStop();
  });

  $("sumRunMine").addEventListener("click", () => {
    const refs = [
      ...views.filter((v) => v.sessionId !== null).map((v) => ({ agent: v.agent as AgentId, sessionId: v.sessionId! })),
      ...favorites.map((f) => ({ agent: f.agent, sessionId: f.sessionId })),
    ];
    runSummaries([...new Map(refs.map((r) => [`${r.agent}|${r.sessionId}`, r])).values()]);
  });
  $("sumRunAll").addEventListener("click", () => {
    // 全部历史要先扫一遍 —— 扫描本身是本地的，不外发（D-8 两个开关独立）
    void api.listSessions().then((r) => {
      allSessions = r.sessions;
      runSummaries(r.sessions.map((s) => ({ agent: s.agent, sessionId: s.sessionId })));
    });
  });
  api.onSummaryProgress((p) => {
    $("sumProgress").textContent =
      t("sum.progress", { done: p.done, total: p.total }) +
      (p.failed ? t("sum.progressFailed", { n: p.failed }) : "") +
      // 截断要看得出来是截断。原来是裸的 slice(0, 30)，**连省略号都不加** ——
      // 一句被砍掉的话看起来就像模型只写了这么多。
      (p.last ? ` · ${p.last.length > 30 ? `${p.last.slice(0, 30)}…` : p.last}` : "");
  });

  // ---------- 诊断（客户机器我们摸不到） ----------

  let diagText = "";
  $("diagRun").addEventListener("click", () => {
    $("diagStatus").textContent = t("diag.collecting");
    void api
      .diagnosticsText()
      .then((d) => {
        diagText = d.text;
        $("diagBox").textContent = d.text;
        $("diagBox").hidden = false;
        $("diagCopy").hidden = false;
        // **读结构化的条数，不去数渲染文本里的 ⚠** —— 从渲染结果里数符号是脆的
        $("diagStatus").textContent = d.problems > 0 ? t("diag.problems", { n: d.problems }) : t("diag.noProblems");
        selfCheck["diag"] = { 字数: d.text.length, 问题: d.problems };
      })
      .catch((e: unknown) => {
        $("diagStatus").textContent = t("diag.collectFailed", { err: cleanIpcError(String(e)) });
      });
  });
  $("diagCopy").addEventListener("click", () => {
    api.copy(diagText);
    $("diagStatus").textContent = t("diag.copied");
  });

  // ---------- Skills 与 MCP（P2-b） ----------

  setupHarness({
    api,
    /**
     * 作用域候选。**第一项是种子** —— 当前 tab 的目录。
     * 这些状态住在这里，所以由这里提供，面板自己不去碰它们。
     */
    scopes: () => {
      const seen = new Set<string>();
      const out: { cwd: string; label: string }[] = [];
      const add = (cwd: string): void => {
        if (!cwd || seen.has(cwd)) return;
        seen.add(cwd);
        // 两种分隔符都要认 —— 只写 / 的话 Windows 路径切不开，下拉里会显示整条绝对路径
        out.push({ cwd, label: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd });
      };
      const active = views.find((v) => v.key === activeKey);
      if (active) add(active.cwd);
      for (const v of views) add(v.cwd);
      for (const f of favorites) add(f.cwd);
      return out;
    },
    note: (v) => {
      selfCheck["harness"] = v;
    },
  });

  // ---------- Agent 版本 ----------

  /** 一行一个 agent。装了但读不出版本的照样列出来，写「版本未知」而不是消失。 */
  function renderVerRows(rows: Awaited<ReturnType<typeof api.agentsState>>["rows"]): void {
    if (rows.length === 0) {
      $("verRows").innerHTML = `<p class="desc">${t("ver.noAgents")}</p>`;
      return;
    }
    $("verRows").innerHTML = rows
      .map((r) => {
        const cur = r.version ?? t("ver.unknown");
        const to = r.hasUpdate ? ` <span class="ver-new">→ ${esc(r.latest!)}</span>` : "";
        const link = r.releasesUrl
          ? `<button class="btn-ghost btn-mini" data-rel="${esc(r.releasesUrl)}">${esc(t("ver.releaseNotes"))}</button>`
          : "";
        /**
         * 「更新」按钮 + 命令本身。
         *
         * **命令留着**：它既是「我们要跑什么」的公示，也仍然可以复制去自己跑 ——
         * 这个项目弄坏过一次 codex，让用户看得见我们要执行什么不是装饰。
         */
        const cmd = r.updateCommand && r.hasUpdate
          ? `<button class="btn-ghost btn-mini" data-update="${esc(r.agent)}">${esc(t("ver.update"))}</button>` +
            `<code class="ver-cmd" data-copy="${esc(r.updateCommand)}" title="${esc(t("ver.copyHint"))}">${esc(r.updateCommand)}</code>`
          : "";
        // 四个格子永远都在，空的也占位 —— 少一个格子后面的列就整体左移
        return `<div class="ver-row">
          <span class="ver-name">${esc(r.agent)}</span>
          <span class="ver-num">${esc(cur)}${to}</span>
          <span class="ver-act">${cmd}</span>
          <span class="ver-act">${link}</span>
        </div>`;
      })
      .join("");
  }

  function renderVerState(st: Awaited<ReturnType<typeof api.agentsState>>): void {
    const on = st.checkEnabled;
    ($("verToggle") as HTMLButtonElement).textContent = on ? t("sum.on") : t("sum.off");
    $("verToggle").setAttribute("aria-pressed", String(on));
    // 一个 agent 都没有时点它会「闪一下又回到还没查过」，看起来像坏了 —— 直接禁用
    const nothing = st.rows.length === 0;
    ($("verCheck") as HTMLButtonElement).disabled = !on || st.checking || nothing;
    const n = st.rows.filter((r) => r.hasUpdate).length;
    $("verStatus").textContent = nothing
      ? t("ver.noCheckable")
      : !on
      ? t("ver.offlineNote")
      : st.checking
        ? t("ver.checking")
        : st.checkedAt === null
          ? t("ver.neverChecked")
          : n
        ? t("ver.someUpdatable", { n, when: new Date(st.checkedAt).toLocaleString() })
        : t("ver.allCurrent", { when: new Date(st.checkedAt).toLocaleString() });
    renderVerRows(st.rows);
  }

  const loadVerState = (): Promise<void> => api.agentsState().then(renderVerState);

  $("verToggle").addEventListener("click", () => {
    const on = $("verToggle").getAttribute("aria-pressed") === "true";
    void api.agentsSetCheckEnabled(!on).then(renderVerState);
  });
  $("verCheck").addEventListener("click", () => {
    $("verStatus").textContent = t("ver.checking");
    ($("verCheck") as HTMLButtonElement).disabled = true;
    void api.agentsCheck().then(renderVerState);
  });
  $("verRows").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("[data-rel],[data-copy],[data-update]") as HTMLElement | null;
    if (!t) return;
    const up = t.getAttribute("data-update");
    if (up) return void updateAgent(up as AgentId);
    const rel = t.getAttribute("data-rel");
    if (rel) return void api.agentsOpenReleases(rel);
    const cmd = t.getAttribute("data-copy");
    if (cmd) {
      api.copy(cmd);
      t.classList.add("copied");
      setTimeout(() => t.classList.remove("copied"), 900);
    }
  });
  /** 齿轮上的小圆点。不打断你，但你不打开设置也知道有事。 */
  function setGearDot(n: number): void {
    selfCheck["agents"] = { 可更新: n };
    $("gear").classList.toggle("has-update", n > 0);
    $("gear").title = n > 0 ? t("set.titleUpdates", { n }) : t("set.title");
  }

  /**
   * **两条路都要，因为它们覆盖的时刻不同。**
   *
   * 主进程在 app-ready 时就查了，那时渲染层还没开始监听 —— 只靠推送，
   * 事件会丢（实测：`齿轮有小圆点: false`）。所以启动时自己拉一次（缓存命中的常见情况），
   * 推送只负责「启动之后才查完」那一种。
   */
  void api.agentsState().then((st) => {
    setGearDot(st.rows.filter((r) => r.hasUpdate).length);
    // 主区空态要说哪一套，取决于这台机器上到底有没有 agent。
    // 这份数据启动时本来就要拉（齿轮小圆点要用），不额外花钱。
    const none = st.rows.length === 0;
    $("teNoAgent").hidden = !none;
    $("teReady").hidden = none;
    // 侧栏的空态跟着主区走，所以这一步之后要重画一次 ——
    // 它很可能在这个 promise 回来之前就已经渲染过了
    paint();
    selfCheck["agents"] = { ...(selfCheck["agents"] as object), 装了: st.rows.length };
  })
  // 不接住的话，空态文案和齿轮小圆点会一起静默停在错的状态
  .catch(() => {
    selfCheck["agents"] = { 读不到: true };
  });
  api.onAgentsUpdateAvailable(setGearDot);

  // ---------- 右键菜单 ----------
  /**
   * 行内动作改成悬停才出现之后，不常用但需要有的动作放这里 ——
   * 往每行塞更多图标会把侧栏变成一列按钮。
   */
  function sessionMenu(v: SessionView): MenuItem[] {
    const starred = v.sessionId !== null && favorites.some((f) => f.sessionId === v.sessionId);
    const items: MenuItem[] = [];
    if (v.paneId === null) items.push({ label: t("menu.start"), run: () => activate(v.key) });
    else items.push({ label: t("menu.switchTo"), run: () => show(v.key) });

    /**
     * 这一行现在显示的是哪段字。**加收藏和「复制摘要」都用它** ——
     * 原来这两处各自直接读 `v.label`（加入工作集时持久化的快照），
     * 于是用户看到一段、复制到另一段，收藏里又存下第三份。
     */
    const sum = labelOfView(v);

    if (v.sessionId !== null) {
      items.push({
        label: starred ? t("side.unfavorite") : t("menu.favorite"),
        run: () => {
          const s = allSessions.find((x) => x.sessionId === v.sessionId);
          if (s) void toggleStar(s);
          else if (starred) {
            void api.favoriteRemove(v.agent as AgentId, v.sessionId!).then((r) => {
              favorites = r.sessions;
              refreshFavorites();
            });
          } else {
            // 还没扫过历史，就用工作集里已有的信息收藏 —— 不为了收藏强制扫一次盘
            void api
              .favoriteAdd({
                agent: v.agent as AgentId,
                sessionId: v.sessionId!,
                cwd: v.cwd,
                ...(sum === null ? {} : { label: sum }),
                addedAt: new Date().toISOString(),
              })
              .then((r) => {
                favorites = r.sessions;
                refreshFavorites();
              });
          }
        },
      });
    }
    /**
     * 摘要在侧栏被 `-webkit-line-clamp: 2` 砍着（点一下能就地展开），
     * 这一项是把它**拿走**的路径。
     *
     * **必须走 `labelOfView`。** 原来直接读 `v.label`，那是加入工作集时持久化的快照 ——
     * 用户复制出来的是一句半截话，而界面上显示的又是另一段字。
     * 空的时候不给这一项 —— 一个复制出「（没有可读的开头）」的菜单项是噪音。
     */
    if (sum !== null) items.push({ label: t("menu.copySummary"), run: () => api.copy(sum) });
    items.push({ label: t("menu.openInExplorer"), run: () => void api.openFolder(v.cwd) });
    items.push({ label: t("menu.copyCwd"), run: () => api.copy(v.cwd) });
    if (v.sessionId !== null) {
      items.push({ label: t("menu.copySessionId"), run: () => api.copy(v.sessionId!) });
    }
    items.push({ label: t("menu.endSession"), danger: true, run: () => void endSession(v.key) });
    return items;
  }

  $("tree").addEventListener("contextmenu", (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>(".sess")?.dataset["key"];
    const v = key === undefined ? undefined : viewOf(key);
    if (!v) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, sessionMenu(v));
  });

  $("favTree").addEventListener("contextmenu", (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>(".sess.fav")?.dataset["fav"];
    const f = key === undefined ? undefined : favorites.find((x) => favoriteKey(x) === key);
    if (!f) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: t("menu.open"), run: () => ($("favTree").querySelector<HTMLElement>(`[data-fav="${CSS.escape(key!)}"]`) as HTMLElement | null)?.click() },
      ...(f.label ? [{ label: t("menu.copySummary"), run: (): void => api.copy(f.label!) }] : []),
      { label: t("menu.openInExplorer"), run: () => void api.openFolder(f.cwd) },
      { label: t("menu.copyCwd"), run: () => api.copy(f.cwd) },
      { label: t("menu.copySessionId"), run: () => api.copy(f.sessionId) },
      {
        label: t("side.unfavorite"),
        danger: true,
        run: () => {
          void api.favoriteRemove(f.agent, f.sessionId).then((r) => {
            favorites = r.sessions;
            refreshFavorites();
            if (historyOpen()) refreshHistory();
          });
        },
      },
    ]);
  });

  /**
   * 历史列表的右键菜单。**这里原本一个都没有** —— 而历史恰恰是摘要被砍得最狠的地方：
   * 单行 `ellipsis`，前面还先被 6 位 session id 占掉一截。
   */
  $("histList").addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".hist-row");
    const s = row ? shown[Number(row.dataset["i"])] : undefined;
    if (!s) return;
    e.preventDefault();
    const label = summaryOf(s.agent, s.sessionId) ?? labelOf(s);
    showMenu(e.clientX, e.clientY, [
      ...(label ? [{ label: t("menu.copySummary"), run: (): void => api.copy(label) }] : []),
      ...(s.cwd !== null
        ? [
            { label: t("menu.openInExplorer"), run: (): void => void api.openFolder(s.cwd!) },
            { label: t("menu.copyCwd"), run: (): void => api.copy(s.cwd!) },
          ]
        : []),
      ...(s.sessionId !== null
        ? [{ label: t("menu.copySessionId"), run: (): void => api.copy(s.sessionId!) }]
        : []),
    ]);
  });

  // ---------- 快捷键 ----------
  const keysOpen = (): boolean => !$("keysScrim").hidden;
  const closeKeys = (): void => {
    $("keysScrim").hidden = true;
  };
  $("keysClose").addEventListener("click", closeKeys);
  $("keysScrim").addEventListener("click", (e) => {
    if (e.target === $("keysScrim")) closeKeys();
  });

  /** 有终端面板的会话，按顶栏标签页的顺序。next/prev/jump 都在这个列表上走。 */
  const live = (): SessionView[] => views.filter((v) => v.paneId !== null);

  /** 字体探测只做一次 —— 本机装了什么在应用开着的这段时间里不会变。 */
  let fontProbes: FontProbe[] | null = null;

  /** 把设置面板里那一节画出来。字号改了之后也要重画，否则数字停在旧值。 */
  function renderFontRow(): void {
    if (!theme) return;
    // 选中态走 `aria-pressed`，和「明暗」那排同一套 —— `.seg` 的样式就是按它写的。
    // 第一版用了 `classList.toggle("on")`：一个没有任何 CSS 规则的类名，
    // 结果四个按钮全是未选中的样子（截图抓到的，冒烟看不出来）。
    for (const b of $("uiFontSeg").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(Number(b.dataset["uiscale"]) === theme!.uiFontScale));
    }
    $("termFontNow").textContent = String(theme.termFontSize);

    fontProbes ??= probeFonts(FONT_CANDIDATES);
    const usable = fontProbes.filter((f) => f.installed && f.mono);
    const sel = $("termFontFamily") as HTMLSelectElement;
    sel.innerHTML =
      `<option value="">${esc(t("font.default"))}</option>` +
      usable.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join("");
    sel.value = theme.termFontFamily ?? "";

    $("termFontNote").textContent =
      t("font.probeNote", { n: usable.length, total: fontProbes.length });
  }

  /**
   * 改字号。**范围由主进程夹**（设置文件用户会手改），这里只负责把结果画上去。
   * 三个入口共用它：Ctrl+= / Ctrl+- / Ctrl+0，以及设置面板里的 −/+。
   */
  const setTermFontSize = (n: number): void => {
    void api.setTheme({ termFontSize: n }).then((s) => {
      theme = s;
      applyFonts();
      renderFontRow();
    });
  };
  const setUiFontScale = (n: number): void => {
    void api.setTheme({ uiFontScale: n }).then((s) => {
      theme = s;
      applyFonts();
      renderFontRow();
    });
  };
  const setTermFontFamily = (f: string | null): void => {
    void api.setTheme({ termFontFamily: f }).then((s) => {
      theme = s;
      applyFonts();
      renderFontRow();
    });
  };

  /**
   * 一键更新一个 agent：**停会话 → 在看得见的终端里跑 → 验版本 → 把会话放回来。**
   *
   * ## 为什么必须先停
   *
   * Windows 对运行中的 exe 加镜像锁（`grok.exe` 有 140 MB，锁得最死），
   * 而 npm 的更新是「删掉整个包目录再重新解包」——
   * 27 个进程里任何一个占着文件就是 EBUSY，留下一个半删的包树。
   * **那正是当年 codex 事故留下「缺失的 shim」的机制。**
   *
   * ## 只信重读出来的版本号
   *
   * npm 退出码 0 不等于装成功：可能装到了另一个 prefix、可能权限不够、
   * 可能 EBUSY 到一半。所以第 ⑤ 步重读 `package.json`，比对前后版本。
   */
  let updating = false;
  async function updateAgent(agent: AgentId): Promise<void> {
    if (updating) return;
    updating = true;
    const say = (s: string): void => {
      $("verStatus").textContent = s;
    };
    try {
      // ① 记下这个 agent 正在跑的会话（为了之后放回来）
      const running = views.filter((v) => v.agent === agent && v.paneId !== null && !v.ephemeral);
      const entries = running.map(entryOfView);

      // ② 停掉，并且**等它们真的死了**
      let stuck = 0;
      if (running.length > 0) {
        say(t("upd.stopping", { n: running.length, agent }));
        for (const v of running) {
          const pane = v.paneId!;
          const wait = waitExit(pane);
          api.kill(pane);
          const code = await wait;
          disposePane(pane);
          views.splice(views.indexOf(v), 1);
          if (code === null) stuck++;
        }
        paint();
      }
      // 没退干净的**带到最终那条消息里**。在循环里 say 会被第 ③ 步立刻覆盖，等于没说。
      const stuckNote = stuck > 0 ? t("upd.stuck", { n: stuck }) : "";

      // ③ 在一个看得见的终端里跑更新
      const [cols, rows] = dims();
      const started = await api.agentsStartUpdate(agent, cols, rows);
      if (!started.ok || !started.id) {
        say(t("upd.cantStart", { err: started.error ?? t("upd.unknownReason") }));
        return;
      }
      say(t("upd.running", { agent, cmd: started.display ?? "" }));
      attach(
        {
          key: `更新|${agent}`,
          agent,
          sessionId: null,
          cwd: "",
          paneId: null,
          state: "notStarted",
          command: started.display ?? "",
          label: t("upd.tabLabel", { agent }),
          ephemeral: true,
        },
        started.id,
      );

      // ④ 等它跑完。npm 装一个包可能要一分钟以上
      const code = await waitExit(started.id, 300_000);

      // ⑤ **重读版本**。退出码只是参考，版本号才是证据
      const st = await api.agentsState();
      const now = st.rows.find((r) => r.agent === agent)?.version ?? null;
      const moved = started.before !== now;
      renderVerState(st);
      if (!moved) {
        say(
          (code === null
            ? t("upd.timedOut", { agent, before: started.before ?? t("upd.unreadable") })
            : t("upd.unchanged", {
                agent,
                before: started.before ?? t("upd.unreadable"),
                code: String(code),
              })) + stuckNote,
        );
        return;
      }

      /**
       * 更新成功了就把那个临时面板收走。
       *
       * **它没有 ✕**：标签栏本来就没有关闭键，而 ephemeral 的 view 不进侧栏，
       * 所以侧栏那个 ✕ 也够不着它 —— 留着就是一个关不掉的标签页。
       * 失败时**刻意留着**：那里面是唯一能说清为什么失败的东西。
       */
      const upView = viewOfPane(started.id);
      disposePane(started.id);
      if (upView) views.splice(views.indexOf(upView), 1);
      paint();

      // ⑥ 把会话放回来
      let back = 0;
      if (entries.length > 0) {
        say(t("upd.restoring", { agent, before: started.before ?? "?", now: now ?? "?", n: entries.length }));
        const outs = await api.workspaceRestoreAll(entries, cols, rows);
        back = outs.filter((o) => o.ok).length;
      }
      say(
        t("upd.done", { agent, before: started.before ?? "?", now: now ?? "?" }) +
          (entries.length > 0 ? t("upd.doneRestored", { back, n: entries.length }) : "") +
          stuckNote,
      );
    } catch (e) {
      say(t("upd.error", { agent, err: cleanIpcError((e as Error).message) }));
    } finally {
      updating = false;
    }
  }

  function runAction(hit: NonNullable<ReturnType<typeof resolve>>): void {
    const l = live();
    const at = l.findIndex((v) => v.key === activeKey);
    switch (hit.action) {
      case "new":
        $("btnNew").click();
        break;
      case "close":
        if (activeKey) void endSession(activeKey);
        break;
      case "history":
        $("btnHistory").click();
        break;
      case "settings":
        openSettings();
        break;
      case "next":
        if (l.length > 1) show(l[(at + 1 + l.length) % l.length]!.key);
        break;
      case "prev":
        if (l.length > 1) show(l[(at - 1 + l.length) % l.length]!.key);
        break;
      // 这三个键以前被 Chromium 拿去做整页缩放（把布局一起缩，而原生窗口控件
      // 不跟着缩，比例当场失调）。改绑到终端字号 —— 每个终端应用都是这么做的。
      case "fontUp":
        setTermFontSize((theme?.termFontSize ?? 13) + 1);
        break;
      case "fontDown":
        setTermFontSize((theme?.termFontSize ?? 13) - 1);
        break;
      case "fontReset":
        setTermFontSize(13);
        break;
      case "jump": {
        const target = l[(hit.n ?? 1) - 1];
        if (target) show(target.key);
        break;
      }
      case "help":
        $("keysScrim").hidden = keysOpen();
        if (keysOpen()) renderShortcuts();
        break;
    }
  }

  addEventListener("keydown", (e) => {
    // 菜单开着时它自己处理键盘，别让全局快捷键抢
    if (menuOpen() && e.key !== "Escape") return;
    const hit = resolve(e, inTextField(document.activeElement));
    if (hit) {
      // 拦下来就不要再传给终端 —— 否则 agent 也会收到这串键
      e.preventDefault();
      runAction(hit);
      return;
    }
    if (e.key !== "Escape") return;
    if (menuOpen()) closeMenu();
    else if (settingsOpen()) closeSettings();
    else if (newOpen()) closeNew();
    else if (historyOpen()) closeHistory();
    else if (keysOpen()) closeKeys();
  });

  // ---------- 收藏区块的点击 ----------
  $("favTree").addEventListener("click", (e) => {
    const tgt = e.target as HTMLElement;

    // 和工作集那边同一条：点摘要是展开，不是把这条收藏恢复成会话
    const expKey = tgt.dataset["expand"];
    if (expKey !== undefined) {
      e.stopPropagation();
      toggleExpand(expKey);
      return;
    }

    const unfav = tgt.closest<HTMLElement>("[data-unfav]")?.dataset["unfav"];
    if (unfav !== undefined) {
      e.stopPropagation();
      const f = favorites.find((x) => favoriteKey(x) === unfav);
      if (f) {
        void api.favoriteRemove(f.agent, f.sessionId).then((r) => {
          favorites = r.sessions;
          refreshFavorites();
          if (historyOpen()) refreshHistory();
        });
      }
      return;
    }

    const key = tgt.closest<HTMLElement>(".sess.fav")?.dataset["fav"];
    const f = key === undefined ? undefined : favorites.find((x) => favoriteKey(x) === key);
    if (!f || favMissing.has(key!)) return;

    // 点收藏 = 恢复进工作集。走的是与「点未启动的成员」完全同一条路径 ——
    // 收藏本身不是第三种运行状态，它只是"以后还要用这个"的一张便条。
    //
    // 既然是同一条路径，已经在工作集里就整个交给 `activate`：有面板它切过去，
    // 没面板它去起 —— 而且在途标志在它里面，不必在这儿再写一份。
    // 原来这里是 `existing?.paneId` 才 show，没面板时会掉下去再 workspaceAdd 一次。
    const favKey = entryKey({ ...f, sessionId: f.sessionId });
    const existing = viewOf(favKey);
    if (existing) {
      activate(existing.key);
      return;
    }
    // 还没进工作集：这条路径自己也要挡住重复点击。
    // 冒烟 `FAVORITE=open2` 复现过：主进程 2 个 pty，界面说 1 个在跑。
    if (starting.has(favKey)) return;
    const entry: WorkspaceEntry = {
      agent: f.agent,
      sessionId: f.sessionId,
      cwd: f.cwd,
      ...(f.label === undefined ? {} : { label: f.label }),
      addedAt: new Date().toISOString(),
    };
    starting.add(favKey);
    sideNote(null);
    const [cols, rows] = dims();
    void api
      .workspaceAdd(entry)
      .then(() => api.workspaceRestoreAll([entry], cols, rows))
      .then(reportRestore)
      .catch((e: Error) => sideNote(cleanIpcError(e.message)))
      .finally(() => starting.delete(favKey));
  });

  void refreshSummaries();

  /**
   * 启动时读到的告警，攒到侧栏那一条里。
   *
   * `entryFile.ts` 的注释写着「调用方负责展示 —— 不静默丢弃用户的记录」，
   * 而在此之前两边的 warnings 都只进了 `selfCheck` 的一个**计数**，没人渲染。
   * 于是「工作集里有一条读不出来」在界面上完全不可见 —— 用户唯一能察觉的方式
   * 是自己数少了一条。攒起来一起说，是因为它们几乎总是同时出现（同一次手改、同一次盘坏）。
   */
  const bootWarnings: string[] = [];
  const noteBootWarnings = (): void => {
    if (bootWarnings.length === 0) return;
    sideNote(t("boot.warnings", { n: bootWarnings.length, first: bootWarnings[0]! }));
  };

  // ---------- 启动：读收藏夹 ----------
  void api.favoritesState().then((st) => {
    favorites = st.favorites.sessions;
    for (const k of st.missingCwd) favMissing.add(k);
    bootWarnings.push(...st.warnings.map((w) => t("boot.favPrefix", { msg: w })));
    selfCheck["favorites"] = {
      count: favorites.length,
      warnings: st.warnings.length,
      missingCwd: st.missingCwd.length,
    };
    refreshFavorites();
    noteBootWarnings();
  });

  // ---------- 启动：读工作集 ----------
  void api.workspaceState().then((st) => {
    for (const e of st.workspace.sessions) views.push(viewFromEntry(e));
    for (const k of st.missingCwd) missingCwd.add(k);
    bootWarnings.push(...st.warnings.map((w) => t("boot.wsPrefix", { msg: w })));
    selfCheck["workspaceLoaded"] = {
      entries: st.workspace.sessions.length,
      warnings: st.warnings.length,
      missingCwd: st.missingCwd.length,
    };
    renderBanner();
    paint();
    noteBootWarnings();
  });
}

(window as unknown as { __agentorySelfCheck: unknown }).__agentorySelfCheck = selfCheck;

/**
 * 字号状态给冒烟看。**要读终端实例上的真实值**，不读我们自己的 state ——
 * 「设置存下了」和「终端真的用上了」是两件事，只验前者等于没验。
 */
(window as unknown as { __agentoryFontState: () => unknown }).__agentoryFontState = () => {
  const first = [...panes.values()][0];
  return {
    uiFontScale: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale").trim(),
    termFontSize: first?.term.options.fontSize ?? null,
    termFontFamily: first?.term.options.fontFamily ?? null,
    panes: panes.size,
    // 探测结果也放进来：这台机器上到底有哪些等宽字体、CJK 是不是双宽。
    // 「列表里有东西」和「列的是对的」是两件事。
    fonts: probeFonts(FONT_CANDIDATES).filter((f) => f.installed),
  };
};
const dumpPane = (paneId: string): string => {
  const p = panes.get(paneId);
  if (!p) return "(没有终端)";
  const buf = p.term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/** 转出**每一个**终端的内容。只转活动的那个，没法证明批量恢复的其余几个也回来了。 */
/**
 * 冒烟用：把一个真的 BEL 写进当前终端。
 *
 * 走的是**完整的真实路径** —— 字节进 xterm.js，由它解析出铃并触发 onBell，
 * 再进我们的处理器。不是直接调处理器，那样测不到"xterm 认不认得这个字节"。
 */
(window as unknown as { __agentoryRingBell: () => string }).__agentoryRingBell = () => {
  const v = views.find((x) => x.paneId !== null);
  if (!v?.paneId) return "没有活动终端";
  panes.get(v.paneId)?.term.write(String.fromCharCode(7));
  return `已向 ${v.agent} 写入 BEL`;
};
(window as unknown as { __agentoryDump: () => string }).__agentoryDump = () => {
  const live = views.filter((v) => v.paneId !== null);
  if (live.length === 0) return "(没有活动终端)";
  return live
    .map((v) => `———— ${v.agent} · ${v.cwd} [${v.state}] ————\n${dumpPane(v.paneId!)}`)
    .join("\n\n");
};
console.log(`自检 ${JSON.stringify(selfCheck)}`);
