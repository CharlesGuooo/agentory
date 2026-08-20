import { t } from "../../shared/i18n";
import { loadEntryFile, saveEntryFile } from "../entryFile";
import type { AgentId } from "../sessions/types";
import type { Favorites, FavoriteEntry } from "./model";

const AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

export interface LoadFavoritesResult {
  favorites: Favorites;
  warnings: string[];
}

function parseFavorite(raw: unknown, index: number): FavoriteEntry {
  if (typeof raw !== "object" || raw === null) throw new Error(t("store.notObject", { i: index + 1 }));
  const o = raw as Record<string, unknown>;
  const { agent, sessionId, cwd, addedAt, label } = o;

  if (typeof agent !== "string" || !AGENTS.includes(agent as AgentId)) {
    throw new Error(t("store.badAgent", { i: index + 1, v: JSON.stringify(agent) }));
  }
  // 与工作集的关键差别：收藏一定指向具体会话，没有 id 就不是一条有效收藏（D-F3）
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error(t("store.noSessionIdFav", { i: index + 1 }));
  }
  if (typeof cwd !== "string" || !cwd) throw new Error(t("store.noCwd", { i: index + 1 }));

  return {
    agent: agent as AgentId,
    sessionId,
    cwd,
    ...(typeof label === "string" && label ? { label } : {}),
    addedAt: typeof addedAt === "string" ? addedAt : new Date(0).toISOString(),
  };
}

/** 读收藏夹。失败语义与工作集共用同一层外壳（D-F5），不是复制的代码。 */
export function loadFavorites(path: string): LoadFavoritesResult {
  const { entries, warnings } = loadEntryFile(path, parseFavorite);
  return { favorites: { version: 1, sessions: entries }, warnings };
}

export function saveFavorites(path: string, fav: Favorites): void {
  saveEntryFile(path, fav.sessions);
}
