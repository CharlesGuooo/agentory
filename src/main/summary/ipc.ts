import { getLang, t } from "../../shared/i18n";
import { app, ipcMain, safeStorage, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
/**
 * 保存过的密钥解不开、已经被挪走了。**一直留着直到用户重填一把新的** ——
 * `readKey()` 只在第一次失败时看得见这件事（之后文件已经不在了），
 * 而界面要能一直说清楚「你的 key 没了、原因是什么」。
 */
let keyDropped = false;
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
    /**
     * 解不开。**这件事必须说出来，而且不能把它直接删掉。**
     *
     * 原来这里是静默 `unlinkSync` —— 注释写的是「换了机器就解不开，删掉让用户重填」。
     * 删掉本身没错（留着只会每次都失败），错在**一个字都不说**：
     * 密钥凭空消失，用户只会以为是自己没保存。
     *
     * 这不是假想的场景，是**真发生过的一次事故**：维护者排查另一个问题时把 userData 里的
     * Chromium 状态整批挪走，其中包括 `Local State` —— 而 `safeStorage` 的密文正是靠
     * 那里面的 OSCrypt 密钥解的。Chromium 重建了一把新的，于是所有密文当场作废。
     * 定位它花了三轮实验，**就因为现场什么都没留下**（见 D-U12）。
     *
     * 改两件事：
     * 1. **挪到一边而不是删** —— 和 `entryFile.ts` 处理坏记录的 `.bak` 一个规矩。
     *    它已经解不开了，留着不为恢复，是为了留下「你确实存过一把」这个事实。
     * 2. **记一个标志**，让界面能说一句话。
     */
    keyDropped = true;
    process.stdout.write("[summary] 保存的 API key 解不开了，已挪到 deepseek.key.unreadable\n");
    try {
      renameSync(p, `${p}.unreadable`);
    } catch {
      // 挪不动（占用、只读）就退回删除 —— 留着一份每次都失败的密文更糟
      try {
        unlinkSync(p);
      } catch {
        /* 都不行也不该让应用起不来 */
      }
    }
    return { key: null, fromEnv: false };
  }
}

export interface SummaryState {
  enabled: boolean;
  hasKey: boolean;
  keyFromEnv: boolean;
  /** 存过的密钥解不开、已被挪到 `.unreadable`。界面要为此说一句话。 */
  keyDropped: boolean;
  /** 缓存里有多少条。 */
  cached: number;
  warnings: string[];
  model: string;
  price: typeof PRICE;
}

export interface SummaryText {
  agent: AgentId;
  sessionId: string;
  /**
   * **已经按当前语言挑好的那一段。** 渲染层不该拿着双语对象自己挑 ——
   * 那会让「显示哪段」变成两个地方共同决定的事。
   */
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
      keyDropped,
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
    // 填了新的就把那条警告收掉 —— 问题已经解决，还挂着就成了噪音
    if (k) keyDropped = false;
    if (!k) {
      if (existsSync(keyPath())) unlinkSync(keyPath());
    } else if (safeStorage.isEncryptionAvailable()) {
      // 新机器上 userData 目录可能还不存在。两个邻居（theme/service.ts、agents/ipc.ts）
      // 都建了，这里漏了 —— 漏的后果是 key 静默丢失。
      mkdirSync(app.getPath("userData"), { recursive: true });
      writeFileSync(keyPath(), safeStorage.encryptString(k));
    }
    return state();
  });

  /** 已有的摘要。渲染层用它填第二行的优先级链。 */
  ipcMain.handle("summary:all", (): SummaryText[] =>
    [...cache.values()].map((e) => ({
      agent: e.agent,
      sessionId: e.sessionId,
      // 取不到就退回另一种语言 —— 一条语言不对的摘要，仍然比「没有可读的开头」有用
      text: e.text[getLang()] || e.text[getLang() === "zh" ? "en" : "zh"],
    })),
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
    if (!s) return t("sum.sessionNotFound");
    const p = buildPayload(s);
    const foot = t("sum.payloadFoot", { bytes: p.bytes, kb: Math.round(p.bytesRead / 1024) });
    return `${renderPayload(p)}\n\n——\n${foot}`;
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
      if (!k.key) return { ok: 0, failed: 0, error: t("sum.noKey") };
      if (running) return { ok: 0, failed: 0, error: t("sum.alreadyRunning") };

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
              // 进度行是给人看的一句话，按当前语言挑一段 —— 双语对象在这里没有意义
              last: o.result.ok ? o.result.text[getLang()] : o.result.error,
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
