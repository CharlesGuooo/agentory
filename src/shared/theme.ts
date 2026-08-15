/** 一组色值。深浅两套各一份。 */
export interface ThemeColors {
  /** 终端背景 */
  bg: string;
  /** 外壳背景（explorer / tab 栏） */
  chrome: string;
  /** 边框 */
  line: string;
  /** 主文字 */
  fg: string;
  /** 次要文字（摘要、状态） */
  dim: string;
  cursor: string;
  accent: string;
  /** 选中态背景 */
  sel: string;
  /** 16 个 ANSI 色槽，标准 xterm 顺序 */
  ansi: string[];
}

export interface Theme {
  id: string;
  name: string;
  dark: ThemeColors;
  light: ThemeColors;
}

/** 用户对明暗的选择。与主题选择正交（D-14）。 */
export type ModeSetting = "system" | "light" | "dark";

/** xterm.js `theme` 里 16 个色槽的键名，标准 ANSI 顺序。 */
const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;
const COLOR_KEYS = ["bg", "chrome", "line", "fg", "dim", "cursor", "accent", "sel"] as const;

function parseColors(raw: unknown, where: string): ThemeColors {
  if (typeof raw !== "object" || raw === null) throw new Error(`${where} 必须是对象`);
  const o = raw as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  for (const k of COLOR_KEYS) {
    const v = o[k];
    if (typeof v !== "string" || !HEX.test(v)) {
      throw new Error(`${where}.${k} 必须是 #rrggbb 形式的颜色，收到 ${JSON.stringify(v)}`);
    }
    out[k] = v;
  }

  const ansi = o["ansi"];
  if (!Array.isArray(ansi) || ansi.length !== 16) {
    throw new Error(`${where}.ansi 必须是长度 16 的数组，收到 ${Array.isArray(ansi) ? ansi.length : typeof ansi}`);
  }
  ansi.forEach((c, i) => {
    if (typeof c !== "string" || !HEX.test(c)) {
      throw new Error(`${where}.ansi[${i}] 必须是 #rrggbb，收到 ${JSON.stringify(c)}`);
    }
  });
  out["ansi"] = [...ansi];

  return out as unknown as ThemeColors;
}

/** 解析一个主题定义。任何问题都抛错，且错误信息指出是哪一项。 */
export function parseTheme(raw: unknown): Theme {
  if (typeof raw !== "object" || raw === null) throw new Error("主题必须是对象");
  const o = raw as Record<string, unknown>;

  const id = o["id"];
  const name = o["name"];
  if (typeof id !== "string" || !id) throw new Error("主题缺少 id");
  if (typeof name !== "string" || !name) throw new Error(`主题 ${id} 缺少 name`);

  if (!o["dark"]) throw new Error(`主题 ${id} 缺少 dark 色组`);
  if (!o["light"]) throw new Error(`主题 ${id} 缺少 light 色组`);

  return {
    id,
    name,
    dark: parseColors(o["dark"], `主题 ${id} 的 dark`),
    light: parseColors(o["light"], `主题 ${id} 的 light`),
  };
}

export interface LoadResult {
  themes: Theme[];
  /** 被跳过的主题及原因。调用方负责展示，不该静默丢弃。 */
  warnings: string[];
}

/**
 * 加载内置 + 用户主题。
 * 单个主题坏掉只跳过它并记一条告警 —— 不能让一个手写坏的 JSON 把整个应用搞崩。
 * 同 id 时用户主题覆盖内置（D-14：自定义走文件，不走 UI）。
 */
export function loadThemes(sources: { builtin: unknown[]; user: unknown[] }): LoadResult {
  const warnings: string[] = [];
  const byId = new Map<string, Theme>();

  const take = (list: unknown[], origin: string): void => {
    for (const raw of list) {
      try {
        const t = parseTheme(raw);
        byId.set(t.id, t);
      } catch (e) {
        warnings.push(`跳过${origin}主题：${(e as Error).message}`);
      }
    }
  };

  take(sources.builtin, "内置");
  take(sources.user, "用户");
  return { themes: [...byId.values()], warnings };
}

/**
 * 决定用主题的哪一面。
 * 只看 mode 与系统值 —— 主题身份不参与，选了 paper 就一直是 paper，
 * 系统深色时给的是 paper 自己的 dark 组，而不是换成别的主题（D-14 的正交原则）。
 */
export function resolveVariant(mode: ModeSetting, systemPrefersDark: boolean): "dark" | "light" {
  if (mode === "light" || mode === "dark") return mode;
  return systemPrefersDark ? "dark" : "light";
}

/** 色值组 → xterm.js 的 `theme`。只给终端该知道的那些，外壳颜色不泄漏进去。 */
export function toXtermTheme(c: ThemeColors): Record<string, string> {
  const out: Record<string, string> = {
    background: c.bg,
    foreground: c.fg,
    cursor: c.cursor,
    selectionBackground: c.sel,
  };
  c.ansi.forEach((hex, i) => {
    out[ANSI_KEYS[i]!] = hex;
  });
  return out;
}

/** 色值组 → 外壳用的 CSS 自定义属性。 */
export function toCssVars(c: ThemeColors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of COLOR_KEYS) out[`--c-${k}`] = c[k];
  return out;
}
