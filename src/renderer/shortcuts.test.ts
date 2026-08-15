import { describe, expect, it } from "vitest";
import { inTextField, resolve, SHORTCUTS, type KeyLike } from "./shortcuts";

const k = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("快捷键解析", () => {
  it("Ctrl+Shift+字母 走应用动作", () => {
    expect(resolve(k("KeyN", { ctrlKey: true, shiftKey: true }), false)?.action).toBe("new");
    expect(resolve(k("KeyW", { ctrlKey: true, shiftKey: true }), false)?.action).toBe("close");
    expect(resolve(k("KeyF", { ctrlKey: true, shiftKey: true }), false)?.action).toBe("history");
    expect(resolve(k("Comma", { ctrlKey: true, shiftKey: true }), false)?.action).toBe("settings");
  });

  /**
   * 这条是这套键位存在的**全部理由**：终端里的 Ctrl+W / Ctrl+A / Ctrl+C 必须原样落到 agent。
   * 少了 Shift 就不是我们的键 —— 一个都不能截。
   */
  it("裸 Ctrl+字母 一个都不截 —— 那些是终端的键", () => {
    for (const code of ["KeyW", "KeyN", "KeyA", "KeyE", "KeyC", "KeyP", "KeyF"]) {
      expect(resolve(k(code, { ctrlKey: true }), false)).toBeNull();
    }
  });

  it("Ctrl+Tab 前后切，加 Shift 反向", () => {
    expect(resolve(k("Tab", { ctrlKey: true }), false)?.action).toBe("next");
    expect(resolve(k("Tab", { ctrlKey: true, shiftKey: true }), false)?.action).toBe("prev");
  });

  it("Ctrl+Alt+数字 跳到第 n 个", () => {
    expect(resolve(k("Digit1", { ctrlKey: true, altKey: true }), false)).toEqual({
      action: "jump",
      n: 1,
    });
    expect(resolve(k("Digit9", { ctrlKey: true, altKey: true }), false)?.n).toBe(9);
    // 0 不在表里 —— 会话从 1 数起
    expect(resolve(k("Digit0", { ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it("光有 Ctrl+Shift 但键不在表里就不匹配", () => {
    expect(resolve(k("KeyQ", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });

  it("带 Meta 键一律不接 —— 那可能是系统级组合", () => {
    expect(resolve(k("KeyN", { ctrlKey: true, shiftKey: true, metaKey: true }), false)).toBeNull();
  });

  it("焦点在输入框时不触发，但 F1 例外", () => {
    expect(resolve(k("KeyN", { ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(resolve(k("Tab", { ctrlKey: true }), true)).toBeNull();
    expect(resolve(k("F1"), true)?.action).toBe("help");
  });

  it("表里每个动作都有展示文本，没有空条目", () => {
    for (const s of SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });
});

describe("焦点判断", () => {
  const el = (tag: string, cls = ""): Element => {
    const e = { tagName: tag, classList: { contains: (c: string) => cls.split(" ").includes(c) } };
    return e as unknown as Element;
  };

  it("搜索框算输入框", () => {
    expect(inTextField(el("INPUT"))).toBe(true);
    expect(inTextField(el("TEXTAREA"))).toBe(true);
  });

  /**
   * **xterm.js 用一个隐藏 textarea 收键盘输入。**
   * 「activeElement 是 textarea 就禁用快捷键」这条朴素规则会把终端里的快捷键全禁掉 ——
   * 而那正是最需要它们的地方（你 90% 的时间焦点都在终端里）。
   */
  it("终端那个隐藏 textarea 不算 —— 否则快捷键在终端里全失效", () => {
    expect(inTextField(el("TEXTAREA", "xterm-helper-textarea"))).toBe(false);
  });

  it("没有焦点元素时不算", () => {
    expect(inTextField(null)).toBe(false);
  });
});
