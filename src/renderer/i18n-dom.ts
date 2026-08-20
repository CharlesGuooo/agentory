import { t, type I18nKey } from "../shared/i18n";

/**
 * 把 `index.html` 里标记过的地方按当前语言填一遍。
 *
 * ## 为什么用属性标记，而不是把 markup 搬进 JS
 *
 * `index.html` 里有 89 处文案。把它们搬进 JS 模板意味着**重写整个骨架** ——
 * 那是把「换文案」变成「重排 DOM」，风险和收益完全不成比例。
 * 标记法只往标签上加一个属性，结构一行不动。
 *
 * ## 四种标记，不多不少
 *
 * - `data-i18n`      → 元素的文本
 * - `data-i18n-html` → 同上，但**允许 `<br>` / `<b>`**（空态那两段有换行和强调）
 * - `data-i18n-title` / `data-i18n-aria` / `data-i18n-ph` → 三个属性
 *
 * `data-i18n-html` 只喂**字典里的常量**，从不接用户数据，所以 `innerHTML` 在这里是安全的；
 * 换成拼 DOM 只会让那两段空态文案变得没法读。
 */
const APPLY: [string, (el: HTMLElement, s: string) => void][] = [
  ["data-i18n", (el, s) => (el.textContent = s)],
  ["data-i18n-html", (el, s) => (el.innerHTML = s)],
  ["data-i18n-title", (el, s) => el.setAttribute("title", s)],
  ["data-i18n-aria", (el, s) => el.setAttribute("aria-label", s)],
  ["data-i18n-ph", (el, s) => el.setAttribute("placeholder", s)],
];

export function applyI18n(root: ParentNode = document): void {
  for (const [attr, set] of APPLY) {
    for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      if (key !== null) set(el, t(key as I18nKey));
    }
  }
}
