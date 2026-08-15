import { app, ipcMain, safeStorage, type BrowserWindow } from "electron";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanAllAgents } from "../sessions/all";
import type { AgentId, Session } from "../sessions/types";
import { loadSummaries, saveSummaries, summaryKey, type SummaryEntry } from "./cache";
import { MODEL, PRICE } from "./deepseek";
import { buildPayload, renderPayload } from "./payload";
import { pending, runJob, toEntry } from "./job";

/** D-6 的第二个 JSON 文件。 */
const cachePath = (): string => join(app.getPath("userData"), "summaries.json");
/** 密钥单独一个文件，密文。不进 settings.json —— 那份文件用户会自己打开手改。 */
const keyPath = (): string => join(app.getPath("userData"), "deepseek.key");

let cache = new Map<string, SummaryEntry>();
let warnings: string[] = [];
let running = false;
let stop = false;

/**
 * 取 API key。
 *
 * **环境变量优先** —— 不想让密钥落盘的人有一条不落盘的路。
 * 落盘的那份用 `safeStorage` 加密：Windows 上走 DPAPI，密文绑定当前账户，
 * 拷到别的机器上解不开。
 */
function readKey(): { key: string | null; fromEnv: boolean } {
  const env = process.env["DEEPSEEK_API_KEY"];
  if (env) return { key: env, fromEnv: true };
  const p = keyPath();
  if (!existsSync(p)) return { key: null, fromEnv: false };
  try {
    return { key: safeStorage.decryptString(readFileSync(p)), fromEnv: false };
  } catch {
    // 换了机器 / 换了账户就解不开。删掉它，让用户重填，而不是反复报错。
    try {
      unlinkSync(p);
    } catch {
      /* 删不掉也没关系 */
    }
    return { key: null, fromEnv: false };
  }
}

export interface SummaryState {
  enabled: boolean;
  hasKey: boolean;
  keyFromEnv: boolean;
  /** 缓存里有多少条。 */
  cached: number;
  warnings: string[];
  model: string;
  price: typeof PRICE;
}

export interface SummaryText {
  agent: AgentId;
  sessionId: string;
  text: string;
}

type Enabled = { get: () => boolean; set: (v: boolean) => void };

export function registerSummaryIpc(getWindow: () => BrowserWindow | null, enabled: Enabled): void {
  const loaded = loadSummaries(cachePath());
  cache = loaded.byKey;
  warnings = loaded.warnings;

  const state = (): SummaryState => {
    const k = readKey();
    return {
      enabled: enabled.get(),
      hasKey: k.key !== null,
      keyFromEnv: k.fromEnv,
      cached: cache.size,
      warnings,
      model: MODEL,
      price: PRICE,
    };
  };

  ipcMain.handle("summary:state", (): SummaryState => state());

  ipcMain.handle("summary:setEnabled", (_e, v: boolean): SummaryState => {
    enabled.set(v);
    return state();
  });

  ipcMain.handle("summary:setKey", (_e, raw: string): SummaryState => {
    const k = raw.trim();
    if (!k) {
      if (existsSync(keyPath())) unlinkSync(keyPath());
    } else if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(keyPath(), safeStorage.encryptString(k));
    }
    return state();
  });

  /** 已有的摘要。渲染层用它填第二行的优先级链。 */
  ipcMain.handle("summary:all", (): SummaryText[] =>
    [...cache.values()].map((e) => ({ agent: e.agent, sessionId: e.sessionId, text: e.text })),
  );

  /**
   * 「看看会发送什么」—— 拿一条真会话渲染**过滤后的真实请求体**。
   *
   * D-8 的整套理由是「不会在用户不知情时把源码发出去」。
   * 这个接口把那句话从承诺变成可验证的事实：展示的就是 `runJob` 会发的同一段文本。
   */
  ipcMain.handle("summary:preview", (_e, ref: { agent: AgentId; sessionId: string }): string => {
    const s = scanAllAgents().sessions.find(
      (x) => x.agent === ref.agent && x.sessionId === ref.sessionId,
    );
    if (!s) return "找不到这条会话";
    const p = buildPayload(s);
    return `${renderPayload(p)}\n\n——\n共 ${p.bytes} 字节，为构造它读了 ${Math.round(p.bytesRead / 1024)} KB`;
  });

  ipcMain.handle("summary:stop", (): void => {
    stop = true;
  });

  /**
   * 批量摘要。`targets` 由渲染层给（工作集 + 收藏，或全部历史）—— 范围是用户的选择，
   * 不该由主进程替他决定。
   */
  ipcMain.handle(
    "summary:run",
    async (_e, refs: { agent: AgentId; sessionId: string }[]): Promise<{ ok: number; failed: number; error?: string }> => {
      const k = readKey();
      if (!k.key) return { ok: 0, failed: 0, error: "还没有填 API key" };
      if (running) return { ok: 0, failed: 0, error: "已经在跑了" };

      const want = new Set(refs.map((r) => summaryKey(r.agent, r.sessionId)));
      const all = scanAllAgents().sessions.filter((s: Session) =>
        want.has(summaryKey(s.agent, s.sessionId)),
      );
      const todo = pending(all, cache);

      running = true;
      stop = false;
      let ok = 0;
      let failed = 0;
      try {
        await runJob(
          todo,
          k.key,
          (o, done, total) => {
            if (o.result.ok) {
              cache.set(
                summaryKey(o.session.agent, o.session.sessionId),
                toEntry(o.session, o.result.text, o.result.model),
              );
              // 每条都落盘：用户随时可能关掉应用，已经花过的钱不能丢
              saveSummaries(cachePath(), cache);
              ok++;
            } else {
              failed++;
            }
            getWindow()?.webContents.send("summary:progress", {
              done,
              total,
              ok,
              failed,
              last: o.result.ok ? o.result.text : o.result.error,
            });
          },
          () => stop,
        );
      } finally {
        running = false;
      }
      return { ok, failed };
    },
  );
}
