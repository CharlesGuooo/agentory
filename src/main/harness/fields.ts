/**
 * 从配置对象里**只取键名**的共用逻辑。
 *
 * ## 这个文件是秘密不外泄的那道结构性保证
 *
 * 实测本机：claude 有 2 处、opencode 有 3 处**明文** API token 直接写在配置文件里
 * （`headers.Authorization`），codex / grok 则全部走环境变量引用。
 * harness 配置是这台机器上密钥密度最高的一类文件。
 *
 * 所以这里的函数**只返回 `string[]` 的键名**，值从来不作为返回值的一部分 ——
 * 照 D-W2 的做法：「没有可改的东西，就不可能改错」。调用方拿不到值，也就无法泄漏值。
 */

/** 是不是一个普通对象（不是数组、不是 null）。 */
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 对象的键名。不是对象就是空数组。**值不进返回值。** */
export const keysOf = (v: unknown): string[] => (isObj(v) ? Object.keys(v) : []);

/**
 * 「这个值是环境变量引用，不是明文」。
 *
 * 实测本机用到的两种写法：
 * - opencode：`{env:BRAVE_API_KEY}`
 * - claude：`$BRAVE_API_KEY`（也接受 `${VAR}`）
 *
 * codex 的 `env_vars = ["NAME"]` / `bearer_token_env_var = "NAME"` 本来就只有名字，
 * 不走这条判定。
 */
const PLACEHOLDER = /^(\{env:[A-Za-z_][A-Za-z0-9_]*\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)$/;

/**
 * **字段名本身就是凭证形状**的那些键。
 *
 * 最初的规则是「任何非占位符字符串值」，实测立刻翻车：它把
 * `env.BLENDER_HOST = "localhost"` 和 14 个 `NODE_REPL_*` 配置值全标成了密钥。
 * 普通环境变量当然有明文值 —— **有值不等于是密钥**。
 *
 * 所以判据是两条同时成立：字段名像凭证 **且** 值不是环境变量引用。
 */
const SECRET_NAME = /(^|_)(key|token|secret|password|passwd|credential|api[_-]?key)($|_)|authorization/i;

/**
 * 值是**明文凭证**（而非环境变量引用）的那些键，返回 `<prefix>.<key>` 形式的路径。
 *
 * **只返回路径，绝不返回值。**
 */
export function inlineSecretPaths(prefix: string, v: unknown): string[] {
  if (!isObj(v)) return [];
  return Object.entries(v)
    .filter(
      ([k, val]) =>
        SECRET_NAME.test(k) && typeof val === "string" && val.length > 0 && !PLACEHOLDER.test(val),
    )
    .map(([k]) => `${prefix}.${k}`);
}

/** 字符串数组里的字符串。用于 codex 的 `env_vars = ["A","B"]`。 */
export const stringsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * URL 去掉 query 和 fragment。
 *
 * token 常藏在查询串里（`?key=…`），而查询串对「跨 agent 对照」零信息量 ——
 * 丢掉是免费的。解析不了就原样返回（它多半根本不是 URL）。
 */
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return raw;
  }
}
