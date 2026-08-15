import type { AgentId } from "../sessions/types";

/**
 * 收藏夹里的一条记录。
 *
 * 与 `WorkspaceEntry` 长得像，但有一处关键差别（D-F3）：**`sessionId` 不可为空**。
 * 工作集里的条目可以是「该目录下最近的会话」（新建时拿不到 id），
 * 而「以后还要用这个」指的是**那一个**会话，不是那个目录里最新的那个。
 *
 * 代价如实记下：在 agentory 里新建的会话收藏不了，因为没有 id 可指。
 */
export interface FavoriteEntry {
  agent: AgentId;
  sessionId: string;
  cwd: string;
  /**
   * 收藏那一刻的预览快照。取不到预览时没有这个字段。
   *
   * **存快照不违反 D-W1**：D-W1 禁的是会过期的字段，而首条用户消息是
   * append-only 历史里不可变的东西。存下来换到的是「启动时零文件读」——
   * 侧栏收藏区块要在启动时就渲染，而扫描是 opt-in 的（D-8，默认关）。
   */
  label?: string;
  /** 收藏时间，ISO 字符串。重复收藏保留最早的那次。 */
  addedAt: string;
}

export interface Favorites {
  version: 1;
  sessions: FavoriteEntry[];
}

export const emptyFavorites = (): Favorites => ({ version: 1, sessions: [] });

/**
 * 条目的主键。
 *
 * 分隔符用 `|`：agent id 与 UUID 里都不会出现。**刻意不用控制字符** ——
 * 主键要写进 DOM 属性再读回来查找，HTML 属性解析会把 U+0000 改写成 U+FFFD，
 * 让每次查找静默失配（D-W4，上一刀踩过）。
 */
export const favoriteKey = (e: Pick<FavoriteEntry, "agent" | "sessionId">): string =>
  `${e.agent}|${e.sessionId}`;

export const hasFavorite = (fav: Favorites, agent: AgentId, sessionId: string): boolean =>
  fav.sessions.some((e) => e.agent === agent && e.sessionId === sessionId);

/** 收藏。重复收藏不产生副本，且**保留最早的 `addedAt`** —— 它记的是"什么时候收的"。 */
export function addFavorite(fav: Favorites, entry: FavoriteEntry): Favorites {
  if (hasFavorite(fav, entry.agent, entry.sessionId)) return fav;
  return { ...fav, sessions: [...fav.sessions, entry] };
}

export function removeFavorite(fav: Favorites, agent: AgentId, sessionId: string): Favorites {
  const key = favoriteKey({ agent, sessionId });
  return { ...fav, sessions: fav.sessions.filter((e) => favoriteKey(e) !== key) };
}
