import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain, nativeTheme, type BrowserWindow } from "electron";
import builtinThemes from "../../shared/builtin-themes.json";
import { langOfLocale, setLang, t, type Lang, type LangSetting } from "../../shared/i18n";
import { loadThemes, type ModeSetting, type Theme } from "../../shared/theme";

export interface ThemeState {
  /** 自定义主题目录的绝对路径。界面要说清楚「放哪」，而它在新机器上还不存在。 */
  themesDir: string;
  themes: Theme[];
  themeId: string;
  mode: ModeSetting;
  systemPrefersDark: boolean;
  /** 被跳过的用户主题及原因。渲染层负责展示，不静默丢弃。 */
  warnings: string[];
  /**
   * 字号。**和主题走同一条 IPC** —— 它们都是「外观」，
   * 为三个数字另开一套 state / 通道只会多出三处要同步的地方。
   */
  uiFontScale: number;
  termFontSize: number;
  /** `null` = 用内置的等宽字体栈。只影响终端，界面不给选（见 D-21）。 */
  termFontFamily: string | null;
  /**
   * 语言。**两个都要给出去**：
   * - `language` 是用户选的那个，设置面板要按它高亮
   * - `lang` 是解析之后的结果，界面要按它显示，而且「跟随系统」那一项得说清楚跟到了哪
   */
  language: LangSetting;
  lang: Lang;
}

interface Settings {
  themeId: string;
  mode: ModeSetting;
  /**
   * 生成摘要 = **内容出境**，所以按 D-8 默认关，且必须是用户显式打开的。
   * 与主题共用这份文件 —— 一类记录一个文件，但开关就是设置，不必另起一份。
   * **API key 不在这里**：这份文件用户会自己打开手改，密钥要加密单独存。
   */
  summariesEnabled: boolean;
  /**
   * 查 agent 最新版。**默认开** —— 它出网，但出去的只有包名，
   * 不含任何用户内容，是 D-8 的第三档，和「生成摘要」那种内容出境不是一回事。
   */
  versionCheckEnabled: boolean;
  /**
   * 「叉掉窗口 = 收进托盘」这件事只在第一次发生时提示一次。
   *
   * 它是**记住说过没说过**，不是一个用户能调的开关，所以不进设置界面。
   * 但它得和别的设置存在一起 —— 一类记录一个文件。
   */
  trayHintShown: boolean;
  /** 界面字号的倍数。CSS 里六个字号档全部乘它。 */
  uiFontScale: number;
  /** 终端字号，px。Ctrl+= / Ctrl+- / Ctrl+0 改的就是它。 */
  termFontSize: number;
  /** 终端字体。`null` = 内置栈。 */
  termFontFamily: string | null;
  /** 界面语言。`system` 跟随 `app.getLocale()`。 */
  language: LangSetting;
}

/**
 * 字号的合法范围。**必须夹住** —— 设置文件用户会手改，
 * 一个 0 或者 400 会让界面直接不可用，而那时他连「设置」两个字都点不着。
 */
const UI_SCALE = { min: 0.8, max: 1.6, step: 0.1, def: 1 };
const TERM_SIZE = { min: 8, max: 28, def: 13 };
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const DEFAULTS: Settings = {
  themeId: "graphite",
  mode: "system",
  summariesEnabled: false,
  versionCheckEnabled: true,
  trayHintShown: false,
  uiFontScale: UI_SCALE.def,
  termFontSize: TERM_SIZE.def,
  termFontFamily: null,
  language: "system",
};

const settingsPath = (): string => join(app.getPath("userData"), "settings.json");
const themesDir = (): string => join(app.getPath("userData"), "themes");

function readSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<Settings>;
    return {
      themeId: typeof raw.themeId === "string" ? raw.themeId : DEFAULTS.themeId,
      mode:
        raw.mode === "light" || raw.mode === "dark" || raw.mode === "system"
          ? raw.mode
          : DEFAULTS.mode,
      summariesEnabled: raw.summariesEnabled === true,
      // 默认开，所以只有显式写 false 才关
      versionCheckEnabled: raw.versionCheckEnabled !== false,
      trayHintShown: raw.trayHintShown === true,
      // 手改坏了的数字不该让界面变得点不着 —— 非数字回默认，超范围夹住
      uiFontScale:
        typeof raw.uiFontScale === "number" && Number.isFinite(raw.uiFontScale)
          ? clamp(raw.uiFontScale, UI_SCALE.min, UI_SCALE.max)
          : UI_SCALE.def,
      termFontSize:
        typeof raw.termFontSize === "number" && Number.isFinite(raw.termFontSize)
          ? Math.round(clamp(raw.termFontSize, TERM_SIZE.min, TERM_SIZE.max))
          : TERM_SIZE.def,
      termFontFamily: typeof raw.termFontFamily === "string" && raw.termFontFamily.trim() !== ""
        ? raw.termFontFamily
        : null,
      language:
        raw.language === "zh" || raw.language === "en" || raw.language === "system"
          ? raw.language
          : DEFAULTS.language,
    };
  } catch {
    // 没有设置文件、或文件坏了 —— 用默认值，不是错误
    return { ...DEFAULTS };
  }
}

/** 给摘要模块用的开关读写。设置文件只有一份，不为一个布尔值再开一个。 */
export const summariesEnabled = {
  get: (): boolean => readSettings().summariesEnabled,
  set: (v: boolean): void => writeSettings({ ...readSettings(), summariesEnabled: v }),
};

/** 给版本检测用的开关读写。 */
export const versionCheckEnabled = {
  get: (): boolean => readSettings().versionCheckEnabled,
  set: (v: boolean): void => writeSettings({ ...readSettings(), versionCheckEnabled: v }),
};

/** 托盘提示说过没说过。同一份文件，同样的读改写。 */
export const trayHintShown = {
  get: (): boolean => readSettings().trayHintShown,
  set: (v: boolean): void => writeSettings({ ...readSettings(), trayHintShown: v }),
};

function writeSettings(s: Settings): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

/** 读用户主题目录。每个 .json 一个主题（D-14：自定义走文件，不做取色器 UI）。 */
function readUserThemes(): { raw: unknown[]; warnings: string[] } {
  const dir = themesDir();
  if (!existsSync(dir)) return { raw: [], warnings: [] };
  const raw: unknown[] = [];
  const warnings: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith(".json")) continue;
    try {
      raw.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch (e) {
      warnings.push(t("theme.badJson", { f, msg: (e as Error).message }));
    }
  }
  return { raw, warnings };
}

/**
 * **设置只有磁盘一个真相。**
 *
 * 这里原本有个模块级的 `settings` 快照，只在 `registerThemeIpc` 时读一次。
 * 而 `summariesEnabled.set` / `versionCheckEnabled.set` 走的是「读盘→改→写盘」，
 * 从不更新那个快照 —— 于是「打开摘要开关，再换个主题」时，`theme:set` 把
 * 陈旧快照整个写回磁盘，刚打开的开关被重置回默认值。反向同理。
 *
 * 每次读盘的代价可以忽略（只有开设置面板、换主题、系统明暗切换时会走到），
 * 换来的是不可能再有第二个真相。
 */
function buildState(): ThemeState {
  const settings = readSettings();
  const lang = resolveLang(settings.language);
  const user = readUserThemes();
  const loaded = loadThemes({ builtin: builtinThemes, user: user.raw });
  // 记住的主题可能来自一个已被删掉的用户主题文件 —— 回退到默认，不是崩溃
  const themeId = loaded.themes.some((x) => x.id === settings.themeId)
    ? settings.themeId
    : DEFAULTS.themeId;
  return {
    themes: loaded.themes,
    themeId,
    themesDir: themesDir(),
    mode: settings.mode,
    systemPrefersDark: nativeTheme.shouldUseDarkColors,
    warnings: [...user.warnings, ...loaded.warnings],
    uiFontScale: settings.uiFontScale,
    termFontSize: settings.termFontSize,
    termFontFamily: settings.termFontFamily,
    language: settings.language,
    lang,
  };
}

/**
 * 当前生效的语言。`system` 走 `app.getLocale()`。
 *
 * **主进程自己也要 `setLang`** —— 它抛出的错误信息是直接显示给用户的，
 * 得在抛的那一刻就是对的语言（见 `shared/i18n.ts` 的注释）。
 * 放在 `buildState` 里是因为那是唯一一处「读设置」的收口，
 * 启动、切主题、改语言都会经过它，不会漏。
 */
function resolveLang(setting: LangSetting): Lang {
  const l = setting === "system" ? langOfLocale(systemLocale()) : setting;
  setLang(l);
  return l;
}

/**
 * 系统语言。
 *
 * 用 `getPreferredSystemLanguages()[0]` 而不是 `getLocale()`：前者是**用户自己排的
 * 语言顺序**，后者是 Chromium 的界面 locale，两者可以不一样。
 * 本机实测：`getLocale()` 是 `en-GB`，`getSystemLocale()` 是 `en-CA`，
 * 而偏好列表是 `["en-CA","zh-Hans-CN"]` —— 一个把 Windows 显示语言设成英文、
 * 但偏好里把中文排第一的用户，只有偏好列表能答对。
 */
function systemLocale(): string {
  return app.getPreferredSystemLanguages()[0] ?? app.getLocale();
}

/**
 * **在任何可能产生用户可见文案的东西之前，先把语言定下来。**
 *
 * 原来只有 `buildState()` 会 `setLang`，而工作集 / 收藏 / 摘要缓存的校验
 * 发生在 `registerXxxIpc` 里 —— 那比第一次 `buildState()` 早。
 * 结果是启动时的告警一半英文一半中文：
 * `"4 records could not be read at startup: Favourites: 跳过条目：第 2 条的 agent 不认识"`
 * 外层是渲染层按新语言拼的，内层是主进程用默认语言抛的。
 */
export function initLang(): Lang {
  return resolveLang(readSettings().language);
}

export function registerThemeIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle("theme:state", (): ThemeState => buildState());

  ipcMain.handle("theme:set", (_e, patch: Partial<Settings>): ThemeState => {
    // 现读现改现写。只动 patch 里给的字段，别的原样带回去 ——
    // 这份文件里还住着两个开关，它们可能刚被别处改过。
    const settings = readSettings();
    if (typeof patch.themeId === "string") settings.themeId = patch.themeId;
    if (patch.mode === "system" || patch.mode === "light" || patch.mode === "dark") {
      settings.mode = patch.mode;
    }
    // 字号一律夹在合法范围里再落盘 —— 渲染层是可以被改的，主进程不该信它
    if (typeof patch.uiFontScale === "number" && Number.isFinite(patch.uiFontScale)) {
      settings.uiFontScale = clamp(patch.uiFontScale, UI_SCALE.min, UI_SCALE.max);
    }
    if (typeof patch.termFontSize === "number" && Number.isFinite(patch.termFontSize)) {
      settings.termFontSize = Math.round(clamp(patch.termFontSize, TERM_SIZE.min, TERM_SIZE.max));
    }
    // 空串 = 回到内置栈。`in` 判断是为了区分「没传」和「传了 null」
    if ("termFontFamily" in patch) {
      const f = patch.termFontFamily;
      settings.termFontFamily = typeof f === "string" && f.trim() !== "" ? f : null;
    }
    if (patch.language === "system" || patch.language === "zh" || patch.language === "en") {
      settings.language = patch.language;
    }
    writeSettings(settings);
    const state = buildState();
    getWindow()?.webContents.send("theme:changed", state);
    return state;
  });

  // 系统明暗切换时即时生效，无需重启（任务 5.7）
  nativeTheme.on("updated", () => {
    getWindow()?.webContents.send("theme:changed", buildState());
  });
}
