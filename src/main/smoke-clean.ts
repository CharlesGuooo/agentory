import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

/**
 * 下面这三个小工具 `smoke.ts` 里也有，但**实现不完全一样**
 * （那边的 `run` 不传 `userGesture`，`say` 的序列化也不同）。
 *
 * 抽成公共模块要先统一它们的行为，而那等于改动 20 个正在通过的冒烟模式 ——
 * 为省 6 行冒这个险不划算。重复在这里是更便宜的那个选择。
 */
const say = (tag: string, msg: unknown): void => {
  process.stdout.write(`[${tag}] ${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const run = (win: BrowserWindow, js: string): Promise<unknown> =>
  win.webContents.executeJavaScript(js, true);

/**
 * 断言函数由 `smoke.ts` 传进来，而不是从那里 import —— 反过来它已经 import 了这个文件，
 * 再互相 import 就成了循环。传参也更明白：这个模块自己不决定「失败了怎么办」。
 */
export type Check = (tag: string, ok: boolean, msg: string) => void;

/**
 * 「一台全新机器上的新用户第一次打开」这条路径。
 *
 * ## 为什么单独一个文件
 *
 * `smoke.ts` 已经 800 行，而这一套关心的东西和别的模式完全不同：
 * 别的模式验「功能对不对」，这一套验**「什么都没有的时候，界面说的话是不是真的」**。
 *
 * ## 它怎么造出一台空机器
 *
 * 不需要第二台机器、也不需要第二个 Windows 账户 —— 三个环境变量就够
 * （见 `scripts/verify-clean.cjs`）：
 *
 * | | 效果 |
 * |---|---|
 * | `USERPROFILE` 指向空目录 | `os.homedir()` 跟着走 → 所有 agent 路径都不存在 |
 * | `APPDATA` 指向空目录 | Electron 的 `userData` 跟着走 → 没有任何配置和缓存 |
 * | `PATH` 里去掉 agent 所在目录 | `where.exe` 找不到 → `resolveCommand` 全抛 = 一个都没装 |
 *
 * ⚠️ `app.getPath("home")` **不**跟 `USERPROFILE` 走（实测仍返回真实家目录）。
 * 我们用的是 `os.homedir()`，所以没问题 —— 但将来谁改用前者，这套验证会静默失效。
 */

/** 取一段文本，压掉空白 —— 断言里要比的是内容不是排版。 */
const TXT = (sel: string): string =>
  `(document.querySelector(${JSON.stringify(sel)})?.textContent ?? "").replace(/\\s+/g," ").trim()`;

/**
 * DPAPI 往返：**加密 → 落盘 → 换一个进程 → 解密**。
 *
 * 分两次启动跑（`scripts/verify-dpapi.cjs` 让两次共用同一个 APPDATA）：
 * - `set`  ：打开摘要开关、填一个假 key、保存
 * - `check`：新进程重新读 —— 输入框的占位文字就是答案
 *
 * 占位文字为什么是答案：`readKey()` 解不开时会**删掉密文文件并返回 null**，
 * 于是占位退回「DeepSeek API key」。所以看到「已保存」就等于加密和解密都成功了。
 *
 * 这条原本被我判成「只有第二个 Windows 账户能验」—— 是错的。
 * 换账户验的是 DPAPI 用了另一把密钥，而机制本身在这里就能验，
 * 而且它正好覆盖 `summary/ipc.ts` 那个缺 `mkdirSync` 的洞（新机器上 userData 还不存在）。
 */
export async function smokeDpapi(win: BrowserWindow, phase: string, check: Check): Promise<void> {
  await wait(1500);
  await run(win, 'document.getElementById("gear").click()');
  await wait(800);
  // 摘要区默认关着，key 输入框藏在开关后面
  await run(win, `(() => {
    const t = document.getElementById("sumToggle");
    if (t.getAttribute("aria-pressed") !== "true") t.click();
  })()`);
  await wait(1200);

  if (phase === "set") {
    await run(win, `(() => {
      const box = document.getElementById("sumKey");
      box.value = "sk-dpapi-roundtrip-测试-12345";
      document.getElementById("sumKeySave").click();
    })()`);
    await wait(1500);
    const set = (await run(
      win,
      `JSON.stringify({
        占位: document.getElementById("sumKey").placeholder,
        输入框已清空: document.getElementById("sumKey").value === "",
        状态: ${TXT("#sumStatus")},
      })`,
    )) as string;
    say("dpapi-set", set);
    const s = JSON.parse(set) as { 占位: string; 输入框已清空: boolean };
    // 存完必须清空 —— 明文留在框里就等于留在渲染进程的内存里
    check("dpapi-set", s.输入框已清空, "存完 key 之后输入框没清空");
    check("dpapi-set", s.占位.includes("已保存"), `占位没变成「已保存」：${s.占位}`);
    return;
  }

  const got = (await run(
    win,
    `JSON.stringify({
      占位: document.getElementById("sumKey").placeholder,
      解密成功: document.getElementById("sumKey").placeholder.includes("已保存"),
    })`,
  )) as string;
  say("dpapi-check", got);
  const c = JSON.parse(got) as { 占位: string; 解密成功: boolean };
  // 换了进程还解得开，才叫 DPAPI 往返成功
  check("dpapi-check", c.解密成功, `全新进程解不开已存的 key，占位是：${c.占位}`);
}

export async function smokeClean(
  win: BrowserWindow,
  shotDir: string | null,
  check: Check,
): Promise<void> {
  /** 截图。**界面这层没有自动化测试** —— 这是唯一能真的看见的办法。 */
  const snap = async (name: string): Promise<void> => {
    if (!shotDir) return;
    mkdirSync(shotDir, { recursive: true });
    const img = await win.capturePage();
    writeFileSync(join(shotDir, `${name}.png`), img.toPNG());
  };

  await wait(1200);

  // ---- 1. 主界面：空态文案说了什么 ----
  const mainRaw = (await run(
    win,
    `JSON.stringify({
        // textContent 会把隐藏子元素的文字也算进去 —— 必须按可见性取
        主区显示的是: document.getElementById("teNoAgent").hidden ? "有 agent 那套" : "没有 agent 那套",
        主区空态: (document.getElementById("teNoAgent").hidden
          ? document.getElementById("teReady")
          : document.getElementById("teNoAgent")).textContent.replace(/\s+/g," ").trim(),
        侧栏: ${TXT("#tree")},
        在跑: ${TXT("#runningCount")},
        历史计数: ${TXT("#historyCount")},
        恢复横幅可见: !document.getElementById("resumeBar").hidden,
        标签页数: document.querySelectorAll("#tabs .tab").length,
        有agent: document.getElementById("teNoAgent").hidden,
      })`,
  )) as string;
  say("clean-main", mainRaw);
  const main = JSON.parse(mainRaw) as { 有agent: boolean; 侧栏: string };
  await snap("clean-01-主界面");

  // ---- 2. 新建会话：有没有出路 ----
  await run(win, 'document.getElementById("btnNew").click()');
  await wait(2500);
  const newRaw = (await run(
    win,
    `JSON.stringify({
        agent区: ${TXT("#newAgents")},
        可点的agent: document.querySelectorAll("#newAgents button").length,
        开始键禁用: document.getElementById("newGo").disabled,
        错误行: ${TXT("#newError")},
        错误行可见: !document.getElementById("newError").hidden,
        目录候选: document.querySelectorAll("#newCwdList option").length,
        出路可见: !document.getElementById("newNoAgent").hidden,
        出路链接数: document.querySelectorAll("#newNoAgent [data-url]").length,
      })`,
  )) as string;
  say("clean-new", newRaw);
  const nw = JSON.parse(newRaw) as { 可点的agent: number; 出路可见: boolean; 出路链接数: number };
  await snap("clean-02-新建会话");
  await run(win, 'document.getElementById("newClose").click()');
  await wait(400);

  // ---- 3. 历史会话：0 条时说什么 ----
  await run(win, 'document.getElementById("btnHistory").click()');
  await wait(3000);
  say(
    "clean-hist",
    await run(
      win,
      `JSON.stringify({
        概要: ${TXT("#histSummary")},
        列表: ${TXT("#histList")},
        计数: ${TXT("#historyCount")},
        agent筛选chip数: document.querySelectorAll("#histAgents button").length,
      })`,
    ),
  );
  await snap("clean-03-历史会话");
  await run(win, 'document.getElementById("histClose").click()');
  await wait(400);

  // ---- 4. Skills 与 MCP ----
  await run(win, 'document.getElementById("btnHarness").click()');
  await wait(2500);
  say(
    "clean-harness",
    await run(
      win,
      `JSON.stringify({
        概要: ${TXT("#hxSummary")},
        状态条: [...document.querySelectorAll("#hxSources .hx-src")].map(s=>s.textContent.replace(/\\s+/g," ").trim()),
        正文: ${TXT("#hxBody")},
        作用域选项: document.getElementById("hxScope").options.length,
      })`,
    ),
  );
  await snap("clean-04-SkillsMCP");
  await run(win, 'document.getElementById("hxClose").click()');
  await wait(400);

  // ---- 5. 设置：Agent 区与诊断 ----
  await run(win, 'document.getElementById("gear").click()');
  await wait(1500);
  const verRaw = (await run(
    win,
    `JSON.stringify({
        agent区: ${TXT("#verRows")},
        状态: ${TXT("#verStatus")},
        现在检查可点: !document.getElementById("verCheck").disabled,
        摘要状态: ${TXT("#sumStatus")},
      })`,
  )) as string;
  say("clean-ver", verRaw);
  const ver = JSON.parse(verRaw) as { 现在检查可点: boolean };

  await run(win, 'document.getElementById("diagRun").click()');
  await wait(4000);
  const diag = (await run(
    win,
    `JSON.stringify({ 结论: ${TXT("#diagStatus")}, 文本: document.getElementById("diagBox").textContent })`,
  )) as string;
  const { 结论, 文本 } = JSON.parse(diag) as { 结论: string; 文本: string };
  say("clean-diag-结论", 结论);
  process.stdout.write(`[clean-diag-begin]\n${文本}\n[clean-diag-end]\n`);
  await run(win, 'document.getElementById("diagBox").scrollIntoView({block:"center"})');
  await wait(300);
  await snap("clean-05-诊断");

  /**
   * ---- 一致性断言 ----
   *
   * **写不变量，不写绝对值。** 这一套要在两种环境下各跑一次（模拟空机器 + 正常对照），
   * 两边该显示的东西完全不同，所以「历史应该是 0 条」这种断言在对照那次必然假红。
   *
   * 而真正坏过的那几处，形状都是**两个独立的地方各说各的**：
   * 侧栏说「装了」主区说「没装」、诊断在一台完全不可用的机器上说「没发现问题」。
   * 这类矛盾在两种环境下都必须不成立 —— 所以断言的是它们之间的关系。
   */
  check(
    "clean",
    main.有agent === nw.可点的agent > 0,
    `主区说${main.有agent ? "有" : "没有"} agent，新建会话面板里有 ${nw.可点的agent} 个可点`,
  );
  check(
    "clean",
    nw.出路可见 === !main.有agent,
    `出路可见=${String(nw.出路可见)}，而主区说${main.有agent ? "有" : "没有"} agent`,
  );
  check("clean", !nw.出路可见 || nw.出路链接数 === 5, `出路可见但只有 ${nw.出路链接数} 个链接`);
  check(
    "clean",
    ver.现在检查可点 === main.有agent,
    `「现在检查」可点=${String(ver.现在检查可点)}，而主区说${main.有agent ? "有" : "没有"} agent`,
  );
  // 修过的那个 bug：一台一个 agent 都没有的机器上，诊断的结论是「没发现问题」
  check(
    "clean",
    main.有agent || !结论.includes("没发现问题"),
    `一个 agent 都没有，诊断却说「${结论}」`,
  );
  check("clean", main.侧栏.includes("工作集是空的") || main.有agent, `侧栏文案：${main.侧栏}`);
}
