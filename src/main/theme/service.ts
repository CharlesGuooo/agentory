import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain, nativeTheme, type BrowserWindow } from "electron";
import builtinThemes from "../../shared/builtin-themes.json";
import { loadThemes, type ModeSetting, type Theme } from "../../shared/theme";

export interface ThemeState {
  themes: Theme[];
  themeId: string;
  mode: ModeSetting;
  systemPrefersDark: boolean;
  /** 被跳过的用户主题及原因。渲染层负责展示，不静默丢弃。 */
  warnings: string[];
}

interface Settings {
  themeId: string;
  mode: ModeSetting;
}

const DEFAULTS: Settings = { themeId: "graphite", mode: "system" };

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
    };
  } catch {
    // 没有设置文件、或文件坏了 —— 用默认值，不是错误
    return { ...DEFAULTS };
  }
}

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
      warnings.push(`主题文件 ${f} 不是合法 JSON：${(e as Error).message}`);
    }
  }
  return { raw, warnings };
}

let settings = { ...DEFAULTS };

function buildState(): ThemeState {
  const user = readUserThemes();
  const loaded = loadThemes({ builtin: builtinThemes, user: user.raw });
  // 记住的主题可能来自一个已被删掉的用户主题文件 —— 回退到默认，不是崩溃
  const themeId = loaded.themes.some((t) => t.id === settings.themeId)
    ? settings.themeId
    : DEFAULTS.themeId;
  return {
    themes: loaded.themes,
    themeId,
    mode: settings.mode,
    systemPrefersDark: nativeTheme.shouldUseDarkColors,
    warnings: [...user.warnings, ...loaded.warnings],
  };
}

export function registerThemeIpc(getWindow: () => BrowserWindow | null): void {
  settings = readSettings();

  ipcMain.handle("theme:state", (): ThemeState => buildState());

  ipcMain.handle("theme:set", (_e, patch: Partial<Settings>): ThemeState => {
    if (typeof patch.themeId === "string") settings.themeId = patch.themeId;
    if (patch.mode === "system" || patch.mode === "light" || patch.mode === "dark") {
      settings.mode = patch.mode;
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
