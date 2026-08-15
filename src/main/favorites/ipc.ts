import { app, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../sessions/types";
import {
  addFavorite,
  emptyFavorites,
  favoriteKey,
  removeFavorite,
  type Favorites,
  type FavoriteEntry,
} from "./model";
import { loadFavorites, saveFavorites } from "./store";

/** D-6 说的是两个 JSON 文件（工作集 + 摘要缓存）。收藏夹是第三个 —— 一类记录一个文件。 */
const favPath = (): string => join(app.getPath("userData"), "favorites.json");

export interface FavoritesState {
  favorites: Favorites;
  /** 读取时被跳过的条目及原因。不静默丢弃用户的记录。 */
  warnings: string[];
  /** 工作目录已不存在的条目 key。**现算，不缓存**（D-W1）。 */
  missingCwd: string[];
}

let current: Favorites = emptyFavorites();
let warnings: string[] = [];

/** 每次变化立即落盘（D-W5，不防抖）。 */
function commit(next: Favorites): Favorites {
  current = next;
  saveFavorites(favPath(), current);
  return current;
}

export function registerFavoritesIpc(): void {
  const loaded = loadFavorites(favPath());
  current = loaded.favorites;
  warnings = loaded.warnings;

  ipcMain.handle(
    "favorites:state",
    (): FavoritesState => ({
      favorites: current,
      warnings,
      missingCwd: current.sessions.filter((e) => !existsSync(e.cwd)).map(favoriteKey),
    }),
  );

  ipcMain.handle("favorites:add", (_e, entry: FavoriteEntry): Favorites =>
    commit(addFavorite(current, entry)),
  );

  ipcMain.handle(
    "favorites:remove",
    (_e, p: { agent: AgentId; sessionId: string }): Favorites =>
      commit(removeFavorite(current, p.agent, p.sessionId)),
  );
}
