import { esc } from "./shell";

/**
 * 右键菜单。
 *
 * 存在的理由：行内动作改成悬停才出现之后，需要一个地方放**不常用但需要有**的动作
 * （复制路径、在资源管理器里打开）。往每行塞更多图标会把侧栏变成一列按钮。
 *
 * 刻意做得很薄：一个 div、一次定位、四种关闭方式。没有子菜单、没有图标、没有动画。
 */

export interface MenuItem {
  label: string;
  run: () => void;
  /** 破坏性动作。视觉上区分开，避免误点。 */
  danger?: boolean;
}

let el: HTMLDivElement | null = null;
let cleanup: (() => void) | null = null;

export function closeMenu(): void {
  el?.remove();
  el = null;
  cleanup?.();
  cleanup = null;
}

export const menuOpen = (): boolean => el !== null;

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  if (items.length === 0) return;

  const box = document.createElement("div");
  box.className = "ctx";
  box.setAttribute("role", "menu");
  box.innerHTML = items
    .map(
      (it, i) =>
        `<button class="ctx-item${it.danger ? " danger" : ""}" role="menuitem" data-i="${i}" type="button">${esc(it.label)}</button>`,
    )
    .join("");
  document.body.appendChild(box);
  el = box;

  // 先放上去再量，才知道会不会超出视口
  const r = box.getBoundingClientRect();
  const pad = 6;
  box.style.left = `${Math.min(x, innerWidth - r.width - pad)}px`;
  box.style.top = `${Math.min(y, innerHeight - r.height - pad)}px`;

  box.querySelector<HTMLButtonElement>(".ctx-item")?.focus();

  box.addEventListener("click", (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>(".ctx-item")?.dataset["i"];
    if (i === undefined) return;
    const item = items[Number(i)];
    closeMenu();
    item?.run();
  });

  // 上下键在菜单里走，Esc 关掉。菜单打开时不该还能用别处的快捷键。
  box.addEventListener("keydown", (e) => {
    const btns = [...box.querySelectorAll<HTMLButtonElement>(".ctx-item")];
    const at = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? at + 1 : at - 1;
      btns[(next + btns.length) % btns.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }
  });

  /**
   * 点**别处**关，滚动也关 —— 菜单不跟着内容走，一滚就会飘到不相干的地方。
   * 刻意只有这两条：resize / blur 那些是想出来的场景，不是撞见的。
   *
   * ⚠️ **「别处」这个判断不能省。**
   *
   * 这里原本是无条件 `closeMenu()`，而它挂在 window 的**捕获阶段**。
   * 鼠标点击的顺序是 `pointerdown → … → click`，所以点菜单项时：
   * pointerdown 先在捕获阶段命中它 → 菜单连同那个按钮被移出 DOM →
   * 等 click 该派发时按钮已经不在文档里 → 55 行那个委托**永远不执行**。
   *
   * 净效果：菜单一点就消失，什么都不发生 —— 和「全是占位」的观感一模一样。
   * 两套菜单的**全部**菜单项一起被打死，而且是从这个文件诞生那天起。
   *
   * 键盘路径不经过 pointerdown，所以那条一直是好的（右键 → ↓ → Enter 能用）。
   * 这个不对称正是当初的判定证据。
   */
  const off = (e: Event): void => {
    if (el && e.target instanceof Node && el.contains(e.target)) return;
    closeMenu();
  };
  addEventListener("pointerdown", off, { capture: true });
  document.addEventListener("scroll", off, { capture: true });
  cleanup = () => {
    removeEventListener("pointerdown", off, { capture: true });
    document.removeEventListener("scroll", off, { capture: true });
  };
}
