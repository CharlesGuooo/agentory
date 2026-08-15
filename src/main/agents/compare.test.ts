import { describe, expect, it } from "vitest";
import { isNewer } from "./compare";

describe("版本比较", () => {
  it("相等就不是新版", () => {
    expect(isNewer("0.147.0", "0.147.0")).toBe(false);
  });

  it("补丁位更大是新版 —— claude 本机的真实情况", () => {
    expect(isNewer("2.1.233", "2.1.220")).toBe(true);
    expect(isNewer("2.1.220", "2.1.233")).toBe(false);
  });

  /**
   * **这条是这个函数存在的理由。**
   *
   * grok 本机装的是 0.2.118，最新是 1.0.4。按字符串比 `"1.0.4" > "0.2.118"` 碰巧对，
   * 但只要比到第三段，`118 > 4` 会让任何「逐段字符串比」判成旧版。
   * 必须按**数字**比，而且高位定胜负之后就不能再看低位。
   */
  it("主版本跨越：1.0.4 比 0.2.118 新", () => {
    expect(isNewer("1.0.4", "0.2.118")).toBe(true);
    expect(isNewer("0.2.118", "1.0.4")).toBe(false);
  });

  it("次版本位", () => {
    expect(isNewer("0.84.2", "0.83.0")).toBe(true); // pi 本机的真实情况
    expect(isNewer("0.83.0", "0.84.2")).toBe(false);
  });

  it("段数不一样时短的按 0 补", () => {
    expect(isNewer("1.1", "1.0.9")).toBe(true);
    expect(isNewer("1.0", "1.0.0")).toBe(false);
  });

  /** 预发布版比同号正式版旧。`1.0.0-beta.1` < `1.0.0`。 */
  it("预发布后缀比正式版旧", () => {
    expect(isNewer("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(isNewer("1.0.0-beta.1", "1.0.0")).toBe(false);
  });

  it("前缀 v 不影响判断", () => {
    expect(isNewer("v1.2.0", "1.1.0")).toBe(true);
  });

  /**
   * **解析不了就不许声称有新版。**
   *
   * 这一条比「判得准」更重要：误报会把用户推去做一次没必要的升级，
   * 而这个产品已经亲手弄坏过一次 codex。宁可什么都不说。
   */
  it("解析不了时一律返回 false，不猜", () => {
    expect(isNewer("", "1.0.0")).toBe(false);
    expect(isNewer("latest", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "")).toBe(false);
    expect(isNewer("1.0.0", "unknown")).toBe(false);
  });
});
