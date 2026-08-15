/**
 * 版本号比较。**零依赖** —— semver 这个包的绝大部分能力（范围、通配、satisfies）
 * 我们一个都不用，这里只要回答一个问题：远端那个是不是比本机这个新。
 */

interface Version {
  /** 数字段，短的由比较方按 0 补齐。 */
  nums: number[];
  /** 预发布后缀（`-` 后面那截），没有就是 null。 */
  pre: string | null;
}

/**
 * `v1.0.0-beta.1` → `{ nums:[1,0,0], pre:"beta.1" }`。认不出就是 null。
 * 模块内私有 —— 它没有第二个调用方，`isNewer` 的测试已经把它的行为钉死了。
 */
function parseVersion(raw: string): Version | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  if (!m?.[1]) return null;
  return { nums: m[1].split(".").map(Number), pre: m[2] ?? null };
}

/**
 * `latest` 是不是比 `installed` 新。
 *
 * **解析不了就返回 false。** 这一条比「判得准」更重要：误报会把用户推去做一次
 * 没必要的升级，而这个项目已经亲手弄坏过一次 codex。宁可什么都不说。
 */
export function isNewer(latest: string, installed: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(installed);
  if (!a || !b) return false;

  const len = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < len; i++) {
    // 段数不一样时短的按 0 补：1.1 比 1.0.9 新
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    // 高位一分胜负就返回 —— 再看低位就会被 0.2.118 的 118 骗过去
    if (x !== y) return x > y;
  }

  // 数字段完全相同，只剩预发布后缀：有后缀的比没后缀的旧
  if (a.pre === b.pre) return false;
  return a.pre === null;
}
