import type { Installed } from "./installed";

/**
 * 查每个 agent 的最新版。
 *
 * ## 出去的字节里有什么
 *
 * **只有包名。** 一次对公共 registry 的匿名 GET，不带 key、不带任何会话内容。
 * 这是 D-8 的第三档：出网，但不含用户数据 —— 和「生成摘要」那种内容出境不是一回事。
 *
 * ## 一个必须记住的坑
 *
 * npm registry 的**缩略元数据 accept 头**（`application/vnd.npm.install-v1+json`）
 * 对 scoped 包的 `/latest` 返回 **406**。实测：`opencode-ai` 能过，
 * `@anthropic-ai/claude-code` / `@openai/codex` / `@earendil-works/pi-coding-agent` 全 406。
 * 用默认 accept 才行。
 */

const NPM = "https://registry.npmjs.org";

/**
 * grok 不走 npm。这两个地址是从它自己的安装脚本里挖出来的
 * （`https://x.ai/cli/install.ps1` 里的 `$BaseUrlPrimary` / `$BaseUrlFallback`），
 * 返回的是一行纯版本号。
 */
const GROK_LATEST = ["https://x.ai/cli/stable", "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable"];

const TIMEOUT_MS = 8000;

export interface LatestOk {
  ok: true;
  version: string;
  /** 「看更新说明」的链接。推不出来就是 null，界面上就不显示那个按钮。 */
  url: string | null;
}
export interface LatestErr {
  ok: false;
  error: string;
}
export type LatestResult = LatestOk | LatestErr;

interface RegistryMeta {
  version?: unknown;
  homepage?: unknown;
  repository?: unknown;
}

/** `github.com/<owner>/<repo>`，尾部的 `.git` / `#readme` / 斜杠都要能吃掉。 */
const GITHUB = /github(?:\.com[/:]|:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/?].*)?$/i;

/**
 * 从 registry 元数据推出 releases 页地址。
 *
 * **推不出来就返回 null，绝不写死一个猜的 URL** —— 烂掉的链接比没有链接更糟。
 * 实测 opencode 的 registry 里 repository 和 homepage 都没有，它那行就没有这个按钮。
 */
export function releasesUrl(meta: RegistryMeta): string | null {
  const repo = meta.repository;
  const candidates = [
    typeof repo === "string" ? repo : undefined,
    typeof repo === "object" && repo !== null ? (repo as { url?: unknown }).url : undefined,
    meta.homepage,
  ];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const m = GITHUB.exec(c.trim());
    if (m) return `https://github.com/${m[1]}/${m[2]}/releases`;
  }
  return null;
}

async function get(url: string): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const why = (e: unknown): string =>
  (e as Error).name === "AbortError" ? "超时" : (e as Error).message;

/** grok：依次试两个地址，返回体就是一行版本号。 */
async function grokLatest(): Promise<LatestResult> {
  let last = "没有可用的地址";
  for (const url of GROK_LATEST) {
    try {
      const r = await get(url);
      if (!r.ok) {
        last = `HTTP ${r.status}`;
        continue;
      }
      const v = (await r.text()).trim();
      if (/^\d+\.\d+/.test(v)) return { ok: true, version: v, url: null };
      last = "返回的不是版本号";
    } catch (e) {
      last = why(e);
    }
  }
  return { ok: false, error: last };
}

/**
 * 一个 agent 的最新版。**失败不抛** —— 查不到最新版不该让整块界面消失，
 * 更不该弹窗。返回 `{ok:false}`，界面显示「查不到」。
 */
export async function fetchLatest(i: Installed): Promise<LatestResult> {
  if (i.agent === "grok") return grokLatest();
  if (i.pkg === null) return { ok: false, error: "不是通过 npm 安装的，查不到来源" };

  try {
    // 注意：这里绝不能加缩略元数据的 accept 头，scoped 包会 406
    const r = await get(`${NPM}/${i.pkg}/latest`);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = (await r.json()) as RegistryMeta;
    if (typeof j.version !== "string") return { ok: false, error: "registry 没给版本号" };
    return { ok: true, version: j.version, url: releasesUrl(j) };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
}
