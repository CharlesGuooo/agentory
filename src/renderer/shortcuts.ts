/**
 * 快捷键表 —— **唯一真源**。处理器和 F1 面板都从这里读，不各写一份。
 *
 * ## 为什么全部走 `Ctrl+Shift`
 *
 * 这个应用的主区域是**终端**。`Ctrl+W`（删词）、`Ctrl+A`/`Ctrl+E`（行首尾）、
 * `Ctrl+P`/`Ctrl+N`（历史）、`Ctrl+C`（中断）在终端里全都有含义，
 * 占用它们是实打实的功能倒退。
 *
 * 终端应用从不使用 `Ctrl+Shift` 组合（那是 Windows Terminal 给应用级动作留的命名空间），
 * 所以这个选择**让冲突问题根本不存在** —— 也就不需要维护一份「哪些键不转发给终端」
 * 的例外名单。那种名单是 VS Code 至今还在维护的东西，也是 bug 的温床。
 */

export type ActionId =
  | "new"
  | "close"
  | "history"
  | "settings"
  | "next"
  | "prev"
  | "jump"
  | "help"
  | "fontUp"
  | "fontDown"
  | "fontReset";

export interface Shortcut {
  /** 展示用。面板里逐字显示。 */
  keys: string;
  label: string;
  action: ActionId;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: "Ctrl+Shift+N", label: "新建会话", action: "new" },
  { keys: "Ctrl+Shift+W", label: "结束当前会话", action: "close" },
  { keys: "Ctrl+Shift+F", label: "历史会话", action: "history" },
  { keys: "Ctrl+Shift+,", label: "设置", action: "settings" },
  { keys: "Ctrl+Tab", label: "下一个会话", action: "next" },
  { keys: "Ctrl+Shift+Tab", label: "上一个会话", action: "prev" },
  { keys: "Ctrl+Alt+1…9", label: "跳到第 n 个会话", action: "jump" },
  { keys: "F1", label: "这份快捷键表", action: "help" },

  /**
   * **上面那条「全部走 Ctrl+Shift」的三个例外，理由要说清楚。**
   *
   * 1. 它们本来就被占着 —— Chromium 拿 `Ctrl+-` 做整页缩放，而那个缩放会把布局
   *    一起缩、原生窗口控件却不跟着缩，**比例当场失调**（用户截图为证）。
   *    也就是说这三个键从来没能传给终端过，改绑不夺走任何现在能用的东西。
   * 2. 每一个终端应用（Windows Terminal、VS Code、iTerm）都用这三个键调字号。
   *    这是肌肉记忆里已经存在的东西，另起一套才是倒退。
   * 3. 放大那半今天**本来就是坏的**（Ctrl+= 不生效）—— 一半能用一半不能用，
   *    比两半都不能用更糟。
   */
  { keys: "Ctrl+=", label: "终端字号放大", action: "fontUp" },
  { keys: "Ctrl+-", label: "终端字号缩小", action: "fontDown" },
  { keys: "Ctrl+0", label: "终端字号回默认", action: "fontReset" },
];

/** 只在面板里露个脸的键。它们由别的路径处理，塞进 SHORTCUTS 会让 action 字段说谎。 */
export const NOTED: { keys: string; label: string }[] = [
  { keys: "Esc", label: "关闭当前弹窗 / 菜单" },
  { keys: "Ctrl+C", label: "中断 agent（原样交给终端）" },
  { keys: "Ctrl+W", label: "删一个词（原样交给终端）" },
];

/** 键盘事件里我们需要的那几个字段。抽成接口是为了能用合成对象测。 */
export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface Hit {
  action: ActionId;
  /** 仅 `jump` 有：1–9 */
  n?: number;
}

/**
 * 焦点是不是落在一个**真的输入框**里。
 *
 * **xterm.js 用一个隐藏的 textarea 收键盘输入**，所以「activeElement 是 textarea
 * 就不触发快捷键」这条朴素规则会把终端里的快捷键全部禁掉 —— 而那恰恰是最需要它们的地方。
 * 靠 `xterm-helper-textarea` 这个类名把终端排除掉。
 */
export function inTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el.classList.contains("xterm-helper-textarea")) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable === true;
}

/**
 * 把一次按键解析成动作，没匹配上返回 null。
 *
 * 用 `code`（物理键位）而不是 `key`：`Ctrl+Shift+,` 的 `key` 在多数布局上是 `<` 而不是 `,`，
 * 按 `key` 匹配会在非美式键盘上悄悄失效。
 */
export function resolve(e: KeyLike, inField: boolean): Hit | null {
  if (e.metaKey) return null;

  // F1 在输入框里也要能用 —— 它是求助，不是编辑动作
  if (e.code === "F1" && !e.ctrlKey && !e.altKey) return { action: "help" };
  if (inField) return null;

  if (e.ctrlKey && !e.altKey && e.code === "Tab") {
    return { action: e.shiftKey ? "prev" : "next" };
  }

  /**
   * 字号三键。**必须匹配，因为不匹配就等于放任 Chromium 去做整页缩放。**
   *
   * `Shift` 不参与判断：主键盘区打 `+` 就是 `Shift+=`，要求「不按 Shift」
   * 会让用户按了 `Ctrl+加号` 却什么都不发生 —— 那正是今天坏掉的那一半。
   * 小键盘的 `NumpadAdd` / `NumpadSubtract` 一并认。
   */
  if (e.ctrlKey && !e.altKey) {
    switch (e.code) {
      case "Equal":
      case "NumpadAdd":
        return { action: "fontUp" };
      case "Minus":
      case "NumpadSubtract":
        return { action: "fontDown" };
      case "Digit0":
      case "Numpad0":
        return { action: "fontReset" };
    }
  }
  if (e.ctrlKey && e.altKey && !e.shiftKey) {
    const m = /^Digit([1-9])$/.exec(e.code);
    if (m) return { action: "jump", n: Number(m[1]) };
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    switch (e.code) {
      case "KeyN":
        return { action: "new" };
      case "KeyW":
        return { action: "close" };
      case "KeyF":
        return { action: "history" };
      case "Comma":
        return { action: "settings" };
    }
  }
  return null;
}
