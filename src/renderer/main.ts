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
}

/** paneId → 终端。切标签页只是换显示哪一个，不销毁另一个。 */
const panes = new Map<string, Pane>();
/** 界面上的会话，**含尚未启动的工作集成员**。key 来自工作集主键。 */
const views: SessionView[] = [];
/** 工作目录已消失的成员 key。由主进程现算给出，不缓存。 */
const missingCwd = new Set<string>();
let activeKey: string | null = null;
let theme: ThemeState | null = null;

const selfCheck: Record<string, unknown> = { bridge: Boolean(agentory) };

const viewOf = (key: string): SessionView | undefined => views.find((v) => v.key === key);
const viewOfPane = (paneId: string): SessionView | undefined =>
  views.find((v) => v.paneId === paneId);

function colorsNow(): ReturnType<typeof toXtermTheme> | null {
  if (!theme) return null;
  const t = theme.themes.find((x) => x.id === theme!.themeId) ?? theme.themes[0];
  return t ? toXtermTheme(t[resolveVariant(theme.mode, theme.systemPrefersDark)]) : null;
}

function paint(): void {
  if (!theme) return;
  const t = theme.themes.find((x) => x.id === theme!.themeId) ?? theme.themes[0];
  if (!t) return;
  const variant = resolveVariant(theme.mode, theme.systemPrefersDark);
  const colors = t[variant];

  for (const p of panes.values()) p.term.options.theme = toXtermTheme(colors);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(toCssVars(colors))) root.style.setProperty(k, v);
  root.dataset["variant"] = variant;
  agentory?.setWindowOverlay(colors.chrome, colors.dim);

  renderSessions(views, activeKey, colors);
  // 一个终端都没有时才显示空态。有会话在跑还挂着"还没有会话在跑"是在撒谎。
  $("termEmpty").hidden = panes.size > 0;
  renderThemeCards(theme.themes, t.id, variant, theme.warnings);
  setModeButtons(theme.mode);
  document.title = `agentory — ${t.name}`;
  selfCheck["theme"] = { id: t.id, variant, bg: colors.bg };
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
    '<p style="padding:12px;color:#e5646e">preload 桥未挂载 —— 无法起会话</p>',
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
    const term = new Terminal({ ...TERM_OPTS, ...(c ? { theme: c } : {}) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    panes.set(paneId, { term, fit, el });

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
    new ResizeObserver(() => {
      if (viewOf(activeKey ?? "")?.paneId === paneId) fit.fit();
    }).observe(el);

    view.paneId = paneId;
    view.state = "running";
    if (!views.includes(view)) views.push(view);
    show(view.key);
    renderBanner();
  }

  // ---------- 总线 ----------
  api.onData((paneId, chunk) => panes.get(paneId)?.term.write(chunk));
  api.onExit((paneId, info) => {
    const v = viewOfPane(paneId);
    // 进程退出**不改变成员资格**（D-5）—— 只改运行状态
    if (v) v.state = "stopped";
    panes.get(paneId)?.term.writeln(`\r\n\x1b[90m[会话已结束，退出码 ${info.exitCode}]\x1b[0m`);
    paint();
  });
  api.onWorkspaceStarted(({ entry, spawned }) => {
    attach(viewOf(entryKey(entry)) ?? viewFromEntry(entry), spawned.id);
  });
  api.onWorkspaceProgress((done, total) => {
    $("resumeNote").textContent = done < total ? `正在恢复 ${done}/${total}…` : "";
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
        label: summaryOf(f.agent, f.sessionId) ?? f.label ?? null,
        dead: favMissing.has(favoriteKey(f)),
      })),
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
    $("histList").innerHTML = '<div class="hist-empty">正在扫描…</div>';
    void api.listSessions().then((r) => {
      allSessions = r.sessions;
      $("historyCount").textContent = String(allSessions.length);
      refreshHistory();
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
    const t = e.target as HTMLElement;

    // 星标与"点开会话"是两个动作。收藏不该顺手把会话起起来 —— 这也是
    // 它们在 DOM 上是两个可点区域而不是一个的原因。
    const starIdx = t.closest<HTMLElement>(".star")?.dataset["star"];
    if (starIdx !== undefined) {
      e.stopPropagation();
      void toggleStar(shown[Number(starIdx)]);
      return;
    }

    const row = t.closest<HTMLElement>(".hist-row");
    if (!row || row.dataset["dead"] === "1") return;
    const s = shown[Number(row.dataset["i"])];
    if (!s || s.cwd === null) return;
    const cwd = s.cwd;
    const [cols, rows] = dims();
    void api
      .resumeSession(s, cols, rows)
      .then(async (r) => {
        closeHistory();
        // 从历史恢复是**显式动作** → 加入工作集（D-5）
        const label = labelOf(s);
        const entry: WorkspaceEntry = {
          agent: s.agent,
          sessionId: s.sessionId,
          cwd,
          ...(label === null ? {} : { label }),
          addedAt: new Date().toISOString(),
        };
        await api.workspaceAdd(entry);
        attach(viewFromEntry(entry), r.id);
      })
      .catch((err: Error) => {
        $("histList").insertAdjacentHTML(
          "afterbegin",
          `<div class="hist-empty">恢复失败：${cleanIpcError(err.message).replace(/</g, "&lt;")}</div>`,
        );
      });
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
        ? '<span class="desc">没有检测到任何 agent</span>'
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
    $("newAgents").innerHTML = '<span class="desc">正在检测…</span>';
    syncNewGo();
    void api.launchOptions().then((o) => {
      paintAgentChips(o.agents);
      $("newCwdList").innerHTML = o.folders
        .map((f) => `<option value="${esc(f)}"></option>`)
        .join("");
      selfCheck["launch"] = {
        agents: o.agents,
        folders: o.folders.length,
        probeMs: Math.round(o.probeMs),
      };
      ($("newCwd") as HTMLInputElement).focus();
      syncNewGo();
    });
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
        await api.workspaceAdd(entry);
        attach(viewFromEntry(entry), r.id);
      })
      .catch((err: Error) => showNewError(`启动 ${agent} 失败：${cleanIpcError(err.message)}`));
  });

  // ---------- 工作集：结束 / 启动未启动的 ----------
  async function endSession(key: string): Promise<void> {
    const v = viewOf(key);
    if (!v) return;
    // 「结束会话」= 杀进程 + 移出工作集（DESIGN.md Q7 定案）
    if (v.paneId !== null) {
      api.kill(v.paneId);
      panes.get(v.paneId)?.el.remove();
      panes.delete(v.paneId);
    }
    await api.workspaceRemove(v.agent as AgentId, v.sessionId, v.cwd);
    views.splice(views.indexOf(v), 1);
    if (activeKey === key) activeKey = views.find((x) => x.paneId !== null)?.key ?? null;
    if (activeKey !== null) show(activeKey);
    else paint();
  }

  function activate(key: string): void {
    const v = viewOf(key);
    if (!v) return;
    if (v.paneId !== null) {
      show(key);
      return;
    }
    // 「未启动」：点一下才真起（D-W3，D-12 的精神实现）
    const [cols, rows] = dims();
    void api.workspaceRestoreAll([entryOfView(v)], cols, rows);
  }

  $("tabs").addEventListener("click", (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>(".tab")?.dataset["key"];
    if (k) show(k);
  });
  $("tree").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const endKey = t.dataset["end"];
    if (endKey) {
      e.stopPropagation();
      void endSession(endKey);
      return;
    }
    const k = t.closest<HTMLElement>(".sess")?.dataset["key"];
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
    if (!bar.hidden) $("resumeCount").textContent = String(n);
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
        bad.length === 0 ? "" : `${bad.length} 个没能恢复：${cleanIpcError(bad[0]!.error ?? "")}`;
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
   * 界面代码不用改 —— 链早就写好了，这里只是把第一位填上。
   */
  const summaries = new Map<string, string>();
  const sumKey = (agent: string, id: string | null): string => `${agent}|${id ?? ""}`;
  const summaryOf = (agent: string, id: string | null): string | undefined =>
    id === null ? undefined : summaries.get(sumKey(agent, id));

  async function refreshSummaries(): Promise<void> {
    for (const s of await api.summaryAll()) summaries.set(sumKey(s.agent, s.sessionId), s.text);
    for (const v of views) v.label = summaryOf(v.agent, v.sessionId) ?? v.label;
    paint();
    refreshFavorites();
    if (historyOpen()) refreshHistory();
  }

  function renderSumState(st: Awaited<ReturnType<typeof api.summaryState>>): void {
    const on = st.enabled;
    ($("sumToggle") as HTMLButtonElement).textContent = on ? "已开启" : "关闭";
    $("sumToggle").setAttribute("aria-pressed", String(on));
    $("sumKeyRow").hidden = !on;
    $("sumActions").hidden = !on || !st.hasKey;
    ($("sumKey") as HTMLInputElement).disabled = st.keyFromEnv;
    ($("sumKey") as HTMLInputElement).placeholder = st.keyFromEnv
      ? "已由 DEEPSEEK_API_KEY 环境变量提供"
      : st.hasKey
        ? "已保存（重新填写可覆盖）"
        : "DeepSeek API key";
    // 费用写在**常驻**状态行里，不写在点完之后的进度行里 ——
    // 点完才告诉你要花多少，那不叫知情。单条价钱不需要知道总数，也就不会被异步结果盖掉。
    // 估算依据：实测载荷约 1200 输入 token，输出 50。2026-08-16 起改峰谷计费，故标日期。
    const per = (1200 * st.price.in + 50 * st.price.out) / 1e6;
    $("sumStatus").textContent = on
      ? `已缓存 ${st.cached} 条 · ${st.model} · 每条约 $${per.toFixed(4)}（估算，价格查证于 ${st.price.checkedAt}）`
      : "关闭时完全离线，第二行退回「开头那句话」";
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
      $("sumPeekBox").textContent = "工作集和收藏都是空的，先加一条会话再看";
      $("sumPeekBox").hidden = false;
      return;
    }
    void api.summaryPreview(ref.agent, ref.sessionId).then((t) => {
      $("sumPeekBox").textContent = t;
      $("sumPeekBox").hidden = false;
    });
  });

  function runSummaries(refs: { agent: AgentId; sessionId: string }[]): void {
    if (refs.length === 0) {
      $("sumProgress").textContent = "没有需要摘要的会话";
      return;
    }
    $("sumProgress").textContent = `准备摘要 ${refs.length} 条…`;
    $("sumStop").hidden = false;
    void api.summaryRun(refs).then((r) => {
      $("sumStop").hidden = true;
      $("sumProgress").textContent = r.error
        ? r.error
        : `完成：成功 ${r.ok} 条${r.failed ? `，失败 ${r.failed} 条` : ""}`;
      void refreshSummaries();
      void loadSumState();
    });
  }

  // 全部历史是几百条串行，跑十几分钟且在花钱 —— 必须能中途叫停
  $("sumStop").addEventListener("click", () => {
    $("sumProgress").textContent = "正在停…（当前这条跑完就停）";
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
      `正在摘要 ${p.done}/${p.total}` +
      (p.failed ? ` · 失败 ${p.failed}` : "") +
      (p.last ? ` · ${p.last.slice(0, 30)}` : "");
  });

  // ---------- 诊断（客户机器我们摸不到） ----------

  let diagText = "";
  $("diagRun").addEventListener("click", () => {
    $("diagStatus").textContent = "正在收集…";
    void api.diagnosticsText().then((t) => {
      diagText = t;
      $("diagBox").textContent = t;
      $("diagBox").hidden = false;
      $("diagCopy").hidden = false;
      // 有 ⚠ 就直说，别让人自己在文本里找
      const bad = (t.match(/⚠/g) ?? []).length;
      $("diagStatus").textContent = bad > 0 ? `${bad} 个问题` : "没发现问题";
      selfCheck["diag"] = { 字数: t.length, 问题: bad };
    });
  });
  $("diagCopy").addEventListener("click", () => {
    api.copy(diagText);
    $("diagStatus").textContent = "已复制，可以直接贴给维护者";
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

  // ---------- Agent 版本（P2-a：只显示，不代劳） ----------

  /** 一行一个 agent。装了但读不出版本的照样列出来，写「版本未知」而不是消失。 */
  function renderVerRows(rows: Awaited<ReturnType<typeof api.agentsState>>["rows"]): void {
    if (rows.length === 0) {
      $("verRows").innerHTML = '<p class="desc">没有检测到任何 agent</p>';
      return;
    }
    $("verRows").innerHTML = rows
      .map((r) => {
        const cur = r.version ?? "版本未知";
        const to = r.hasUpdate ? ` <span class="ver-new">→ ${esc(r.latest!)}</span>` : "";
        const link = r.releasesUrl
          ? `<button class="btn-ghost btn-mini" data-rel="${esc(r.releasesUrl)}">看更新说明</button>`
          : "";
        // 更新命令只给复制。这个项目已经亲手弄坏过一次 codex，绝不代跑。
        const cmd = r.updateCommand && r.hasUpdate
          ? `<code class="ver-cmd" data-copy="${esc(r.updateCommand)}" title="点击复制">${esc(r.updateCommand)}</code>`
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
    ($("verToggle") as HTMLButtonElement).textContent = on ? "已开启" : "关闭";
    $("verToggle").setAttribute("aria-pressed", String(on));
    ($("verCheck") as HTMLButtonElement).disabled = !on || st.checking;
    const n = st.rows.filter((r) => r.hasUpdate).length;
    $("verStatus").textContent = !on
      ? "关闭时只显示本机版本，完全离线"
      : st.checking
        ? "正在查…"
        : st.checkedAt === null
          ? "还没查过最新版"
          : `${n ? `${n} 个可更新 · ` : "都是最新的 · "}上次检查 ${new Date(st.checkedAt).toLocaleString()}`;
    renderVerRows(st.rows);
  }

  const loadVerState = (): Promise<void> => api.agentsState().then(renderVerState);

  $("verToggle").addEventListener("click", () => {
    const on = $("verToggle").getAttribute("aria-pressed") === "true";
    void api.agentsSetCheckEnabled(!on).then(renderVerState);
  });
  $("verCheck").addEventListener("click", () => {
    $("verStatus").textContent = "正在查…";
    ($("verCheck") as HTMLButtonElement).disabled = true;
    void api.agentsCheck().then(renderVerState);
  });
  $("verRows").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("[data-rel],[data-copy]") as HTMLElement | null;
    if (!t) return;
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
    $("gear").title = n > 0 ? `设置（${n} 个 agent 可更新）` : "设置";
  }

  /**
   * **两条路都要，因为它们覆盖的时刻不同。**
   *
   * 主进程在 app-ready 时就查了，那时渲染层还没开始监听 —— 只靠推送，
   * 事件会丢（实测：`齿轮有小圆点: false`）。所以启动时自己拉一次（缓存命中的常见情况），
   * 推送只负责「启动之后才查完」那一种。
   */
  void api.agentsState().then((st) => setGearDot(st.rows.filter((r) => r.hasUpdate).length));
  api.onAgentsUpdateAvailable(setGearDot);

  // ---------- 右键菜单 ----------
  /**
   * 行内动作改成悬停才出现之后，不常用但需要有的动作放这里 ——
   * 往每行塞更多图标会把侧栏变成一列按钮。
   */
  function sessionMenu(v: SessionView): MenuItem[] {
    const starred = v.sessionId !== null && favorites.some((f) => f.sessionId === v.sessionId);
    const items: MenuItem[] = [];
    if (v.paneId === null) items.push({ label: "启动", run: () => activate(v.key) });
    else items.push({ label: "切到这个会话", run: () => show(v.key) });

    if (v.sessionId !== null) {
      items.push({
        label: starred ? "取消收藏" : "收藏",
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
                ...(v.label ? { label: v.label } : {}),
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
    items.push({ label: "在资源管理器中打开", run: () => void api.openFolder(v.cwd) });
    items.push({ label: "复制工作目录", run: () => api.copy(v.cwd) });
    if (v.sessionId !== null) {
      items.push({ label: "复制 session id", run: () => api.copy(v.sessionId!) });
    }
    items.push({ label: "结束会话", danger: true, run: () => void endSession(v.key) });
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
      { label: "打开", run: () => ($("favTree").querySelector<HTMLElement>(`[data-fav="${CSS.escape(key!)}"]`) as HTMLElement | null)?.click() },
      { label: "在资源管理器中打开", run: () => void api.openFolder(f.cwd) },
      { label: "复制工作目录", run: () => api.copy(f.cwd) },
      { label: "复制 session id", run: () => api.copy(f.sessionId) },
      {
        label: "取消收藏",
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
    const t = e.target as HTMLElement;

    const unfav = t.closest<HTMLElement>("[data-unfav]")?.dataset["unfav"];
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

    const key = t.closest<HTMLElement>(".sess.fav")?.dataset["fav"];
    const f = key === undefined ? undefined : favorites.find((x) => favoriteKey(x) === key);
    if (!f || favMissing.has(key!)) return;

    // 点收藏 = 恢复进工作集。走的是与「点未启动的成员」完全同一条路径 ——
    // 收藏本身不是第三种运行状态，它只是"以后还要用这个"的一张便条。
    const existing = viewOf(entryKey({ ...f, sessionId: f.sessionId }));
    if (existing?.paneId) {
      show(existing.key);
      return;
    }
    const entry: WorkspaceEntry = {
      agent: f.agent,
      sessionId: f.sessionId,
      cwd: f.cwd,
      ...(f.label === undefined ? {} : { label: f.label }),
      addedAt: new Date().toISOString(),
    };
    const [cols, rows] = dims();
    void api.workspaceAdd(entry).then(() => api.workspaceRestoreAll([entry], cols, rows));
  });

  void refreshSummaries();

  // ---------- 启动：读收藏夹 ----------
  void api.favoritesState().then((st) => {
    favorites = st.favorites.sessions;
    for (const k of st.missingCwd) favMissing.add(k);
    selfCheck["favorites"] = {
      count: favorites.length,
      warnings: st.warnings.length,
      missingCwd: st.missingCwd.length,
    };
    refreshFavorites();
  });

  // ---------- 启动：读工作集 ----------
  void api.workspaceState().then((st) => {
    for (const e of st.workspace.sessions) views.push(viewFromEntry(e));
    for (const k of st.missingCwd) missingCwd.add(k);
    selfCheck["workspaceLoaded"] = {
      entries: st.workspace.sessions.length,
      warnings: st.warnings.length,
      missingCwd: st.missingCwd.length,
    };
    renderBanner();
    paint();
  });
}

(window as unknown as { __agentorySelfCheck: unknown }).__agentorySelfCheck = selfCheck;
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
