import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { livePids } from "./terminal/ipc";
import { smokeClean, smokeDpapi } from "./smoke-clean";

/**
 * 冒烟模式：从命令行走完整的点击路径，打印自检，退出。
 *
 * 界面这一层没有自动化单元测试（docs/research-notes.md §9 明确不建前端测试设施），
 * 这里就是它的替代品 —— 守的是「接线接上了没有」，不是逻辑对不对，
 * 逻辑在 `workspace/` `sessions/` 里有真正的测试守着。
 *
 * 从 `index.ts` 里抽出来的：主进程入口不该有一半篇幅是测试脚手架。
 */

const env = (k: string): string | undefined => process.env[`AGENTORY_SMOKE_${k}`];
const say = (tag: string, msg: unknown): void => {
  process.stdout.write(`[${tag}] ${String(msg)}\n`);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const smokeEnabled = (): boolean => process.env["AGENTORY_SMOKE"] === "1";

/** 在渲染进程里跑一段脚本。返回值原样带回。 */
const run = (win: BrowserWindow, js: string): Promise<unknown> =>
  win.webContents.executeJavaScript(js);

/** 走「新建会话」的完整点击路径：开选择器 → 选 agent → 填目录 → 按开始。 */
async function smokeNew(win: BrowserWindow): Promise<void> {
  const dir = JSON.stringify(env("NEW_CWD") ?? process.cwd());
  await run(win, 'document.getElementById("btnNew").click()');
  await wait(2500);
  say(
    "smoke-new",
    await run(
      win,
      `(() => {
        const chip = document.querySelector('#newAgents button');
        if (!chip) return "没有可选的 agent";
        chip.click();
        const box = document.getElementById("newCwd");
        box.value = ${dir};
        box.dispatchEvent(new Event("input"));
        const go = document.getElementById("newGo");
        if (go.disabled) return "开始按钮仍不可用";
        go.click();
        return "已点击开始：" + chip.dataset.agent;
      })()`,
    ),
  );
  await wait(3000);
  say(
    "smoke-new-after",
    await run(
      win,
      `JSON.stringify({
        errShown: !document.getElementById("newError").hidden,
        errText: document.getElementById("newError").textContent,
        pickerStillOpen: !document.getElementById("newScrim").hidden,
        tabs: document.querySelectorAll("#tabs .tab").length,
        空态还在: !document.getElementById("termEmpty").hidden,
      })`,
    ),
  );
}

/**
 * 走「从历史恢复」的点击路径：开历史 → 用搜索框缩小 → 点前 n 条。
 *
 * 用真实的搜索框而不是另加一套选择参数 —— 少一条只在测试里存在的代码路径。
 */
async function smokeFromHistory(win: BrowserWindow, n: number): Promise<void> {
  const filter = JSON.stringify(env("HISTORY_FILTER") ?? "");
  await run(win, 'document.getElementById("btnHistory").click()');
  await wait(Number(env("SCAN_WAIT") ?? 6000));
  say(
    "smoke-hist",
    await run(
      win,
      `(() => {
        const box = document.getElementById("histSearch");
        box.value = ${filter};
        box.dispatchEvent(new Event("input"));
        const rows = [...document.querySelectorAll("#histList .hist-row")]
          .filter((r) => r.dataset.dead !== "1");
        const picked = rows.slice(0, ${n});
        picked.forEach((r) => r.click());
        const all = [...document.querySelectorAll("#histList .hist-row")];
        return JSON.stringify({
          summary: document.getElementById("histSummary").textContent,
          matchedAll: all.length,
          alive: rows.length,
          sample: all.slice(0, 3).map((r) => r.querySelector(".cwd").textContent),
          clicked: picked.map((r) => r.querySelector(".cwd").textContent),
        });
      })()`,
    ),
  );
  await wait(Number(env("HISTORY_WAIT") ?? 12_000));
}

/** 量历史列表的重建耗时。搜索框每敲一个字就整表重建，这是 add-session-resume 遗留的 4.5。 */
async function smokeHistPerf(win: BrowserWindow): Promise<void> {
  await run(win, 'document.getElementById("btnHistory").click()');
  await wait(Number(env("SCAN_WAIT") ?? 9000));
  say(
    "smoke-hist-perf",
    await run(
      win,
      `(() => {
        const box = document.getElementById("histSearch");
        const type = (v) => {
          const t0 = performance.now();
          box.value = v; box.dispatchEvent(new Event("input"));
          return Math.round((performance.now() - t0) * 10) / 10;
        };
        const total = document.querySelectorAll("#histList .hist-row").length;
        const runs = ["", "c", "cl", "cla", ""].map(type);
        return JSON.stringify({ 总行数: total, 每次按键毫秒: runs });
      })()`,
    ),
  );
}

/**
 * 关掉恢复面板，改从侧栏点一个「未启动」的成员把它启动（D-W3）。
 *
 * 和 ✕ 一样走 `data-key` 查找 —— 那条路径曾经因为主键里的 U+0000
 * 被 HTML 解析改写而整条哑掉，且一声不响。所以它需要一个常设的守门测试。
 */
async function smokeStartMember(win: BrowserWindow): Promise<void> {
  say(
    "smoke-start",
    await run(
      win,
      `(() => {
        const rows = [...document.querySelectorAll("#tree .sess")];
        const target = rows.find((r) => r.querySelector(".state").textContent === "未启动");
        if (!target) return "侧栏里没有未启动的成员";
        target.click();
        return "已点击：" + target.querySelector(".cmd").textContent.trim();
      })()`,
    ),
  );
  await wait(Number(env("START_WAIT") ?? 30_000));
  say(
    "smoke-start-after",
    await run(
      win,
      `JSON.stringify({
        running: document.getElementById("runningCount").textContent,
        tabs: document.querySelectorAll("#tabs .tab").length,
      })`,
    ),
  );
}

/**
 * 走「从历史点亮五角星 → 收藏区块出现 → 点它 → 取消收藏」的完整点击路径。
 *
 * **必须有这条**：星标与收藏项都靠 `data-key` 查找，正是上一刀里被主键中的 U+0000
 * 悄悄哑掉的那类路径 —— 那次四个交互全是死的，却一个错都没报，
 * 是靠一条真机检查才发现的。
 */
async function smokeFavorite(win: BrowserWindow): Promise<void> {
  const filter = JSON.stringify(env("HISTORY_FILTER") ?? "");
  await run(win, 'document.getElementById("btnHistory").click()');
  await wait(Number(env("SCAN_WAIT") ?? 8000));

  say(
    "smoke-fav-star",
    await run(
      win,
      `(() => {
        const box = document.getElementById("histSearch");
        box.value = ${filter};
        box.dispatchEvent(new Event("input"));
        const row = [...document.querySelectorAll("#histList .hist-row")]
          .find((r) => r.dataset.dead !== "1");
        if (!row) return "没有可收藏的历史行";
        const star = row.querySelector(".star");
        const was = star.getAttribute("aria-pressed");
        star.click();
        return JSON.stringify({ 星标前: was, 第二行: row.querySelector(".lbl").textContent.trim() });
      })()`,
    ),
  );
  await wait(1200);

  say(
    "smoke-fav-after",
    await run(
      win,
      `(() => {
        document.getElementById("histClose").click();
        const rows = [...document.querySelectorAll("#favTree .sess.fav")];
        return JSON.stringify({
          区块可见: !document.getElementById("favWrap").hidden,
          条数: rows.length,
          计数: document.getElementById("favCount").textContent,
          首条: rows[0] ? rows[0].querySelector(".sum").textContent.trim() : null,
        });
      })()`,
    ),
  );

  if (env("FAVORITE") === "dead") {
    say(
      "smoke-fav-dead",
      await run(
        win,
        `(() => {
          const rows = [...document.querySelectorAll("#favTree .sess.fav")];
          const dead = rows.filter((r) => r.classList.contains("dead"));
          const before = document.querySelectorAll("#tabs .tab").length;
          dead.forEach((r) => r.click());
          return JSON.stringify({
            总条数: rows.length,
            标记为失效: dead.length,
            失效那条显示: dead[0] ? dead[0].querySelector(".sum").textContent.trim() : null,
            点它之后新开的标签页: document.querySelectorAll("#tabs .tab").length - before,
          });
        })()`,
      ),
    );
    await wait(3000);
  }

  if (env("FAVORITE") === "open") {
    // 点收藏项 = 恢复进工作集，与点「未启动的成员」同一条路径
    say("smoke-fav-open", await run(win, 'document.querySelector("#favTree .sess.fav").click()'));
    await wait(Number(env("START_WAIT") ?? 30_000));
    say(
      "smoke-fav-opened",
      await run(
        win,
        `JSON.stringify({
          tabs: document.querySelectorAll("#tabs .tab").length,
          running: document.getElementById("runningCount").textContent,
        })`,
      ),
    );
  }

  if (env("FAVORITE") === "unstar") {
    say(
      "smoke-fav-unstar",
      await run(win, 'document.querySelector("#favTree [data-unfav]").click()'),
    );
    await wait(1200);
    say(
      "smoke-fav-gone",
      await run(
        win,
        `JSON.stringify({
          区块可见: !document.getElementById("favWrap").hidden,
          条数: document.querySelectorAll("#favTree .sess.fav").length,
        })`,
      ),
    );
  }
}

interface Proc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
}

/** 全系统进程快照。孤儿只能靠这个查 —— `process.kill(pid,0)` 看不到子孙。 */
function procs(): Proc[] {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out) as Proc[];
}

/** 这些 pid 自己 + 全部子孙。agent 会再起一堆子进程，只看根 pid 会漏掉它们。 */
function tree(roots: number[], all: Proc[]): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const p of all) kids.set(p.ParentProcessId, [...(kids.get(p.ParentProcessId) ?? []), p]);
  const byId = new Map(all.map((p) => [p.ProcessId, p]));
  const seen = new Map<number, Proc>();
  const walk = (pid: number): void => {
    for (const c of kids.get(pid) ?? []) {
      if (seen.has(c.ProcessId)) continue;
      seen.set(c.ProcessId, c);
      walk(c.ProcessId);
    }
  };
  for (const r of roots) {
    const p = byId.get(r);
    if (p) seen.set(r, p);
    walk(r);
  }
  return [...seen.values()];
}

/**
 * 点掉第一个会话的 ✕：既要终止**整棵进程树**，也要移出工作集。
 *
 * 检查在应用还活着的时候做 —— 等退出后再看，`will-quit` 的兜底清理
 * 会把漏杀的也一起收走，那就永远测不出「结束会话」自己漏没漏。
 */
async function smokeEnd(win: BrowserWindow): Promise<void> {
  await wait(Number(env("END_AFTER") ?? 0));
  // 按**根 pid 分组**，不是合成一棵。合起来算的话，只结束 N 个里的 1 个时，
  // 另外 N-1 棵还活着会被算成"幸存 37 个"，看着像漏杀，其实完全正常 —— 报数会骗人。
  const snap = procs();
  const before = livePids().map((root) => ({ root, pids: tree([root], snap).map((p) => p.ProcessId) }));
  say("smoke-end-tree-before", JSON.stringify(before.map((b) => `${b.root}:${b.pids.length}个`)));

  say(
    "smoke-end",
    await run(
      win,
      `(() => {
        const before = document.querySelectorAll("#tree .sess").length;
        const x = document.querySelector("#tree .sess .end");
        if (!x) return "侧栏里没有会话可结束";
        x.click();
        return "结束前成员数 " + before;
      })()`,
    ),
  );
  /**
   * **轮询到整树消失，不固定等**。
   *
   * 原来固定等 4 秒，机器一忙就会拍到「还在退出中」的中间态，报成漏杀 ——
   * 实测出现过一次 35→33，两次对照却都干净。固定等待时长的检查会周期性变红，
   * 而周期性变红的检查会训练人忽略红色（`resume-real.test.ts` 里已经栽过一次）。
   */
  const gone = (): boolean => {
    const now = new Set(procs().map((p) => p.ProcessId));
    return before.some((b) => b.pids.every((id) => !now.has(id)));
  };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !gone()) await wait(500);

  const now = new Set(procs().map((p) => p.ProcessId));
  const after = before.map((b) => ({
    root: b.root,
    was: b.pids.length,
    survived: b.pids.filter((id) => now.has(id)).length,
  }));
  // 通过的形态：**恰好一棵**整树归零，其余原样活着
  const wiped = after.filter((a) => a.survived === 0);
  say(
    "smoke-end-orphans",
    JSON.stringify({
      整树消失: wiped.length,
      各棵: after.map((a) => `${a.root}: ${a.was}→${a.survived}`),
    }),
  );
  say(
    "smoke-end-after",
    await run(
      win,
      `JSON.stringify({
        members: document.querySelectorAll("#tree .sess").length,
        tabs: document.querySelectorAll("#tabs .tab").length,
      })`,
    ),
  );
}

/**
 * 把当前窗口存成 PNG。
 *
 * 界面这层没有自动化测试，评审又不能靠读 CSS 猜渲染结果 ——
 * 这是唯一能「真的看见」的办法。
 * `AGENTORY_SMOKE_SHOT=<目录>`，配合 `SHOT_STEP` 决定截哪几屏。
 */
async function shoot(win: BrowserWindow, dir: string, name: string): Promise<void> {
  const img = await win.capturePage();
  const file = join(dir, `${name}.png`);
  writeFileSync(file, img.toPNG());
  say("smoke-shot", `${name} → ${img.getSize().width}×${img.getSize().height}`);
}

/**
 * Agent 版本：开设置 → 读表 → 复制更新命令。
 *
 * **要证明的第一件事是「没起 agent 进程」** —— 这个项目最贵的一次事故就是探针
 * 碰了 agent 的 TUI。所以这里同时记下耗时：起五个进程不可能是这个数量级。
 */
async function smokeVersions(win: BrowserWindow): Promise<void> {
  // 小圆点必须在点齿轮**之前**读 —— 点开设置就当你看过了，它会被清掉
  say(
    "smoke-ver-dot",
    await run(
      win,
      `JSON.stringify({
        齿轮有小圆点: document.getElementById("gear").classList.contains("has-update"),
        齿轮提示: document.getElementById("gear").title,
      })`,
    ),
  );
  await run(win, 'document.getElementById("gear").click()');
  await wait(1500);
  say(
    "smoke-ver",
    await run(
      win,
      `(() => {
        const rows = [...document.querySelectorAll("#verRows .ver-row")].map((r) => ({
          agent: r.querySelector(".ver-name").textContent,
          版本: r.querySelector(".ver-num").textContent.replace(/\s+/g, " ").trim(),
          有更新命令: !!r.querySelector(".ver-cmd"),
          有说明链接: !!r.querySelector("[data-rel]"),
        }));
        return JSON.stringify({
          开关: document.getElementById("verToggle").getAttribute("aria-pressed"),
          状态: document.getElementById("verStatus").textContent,
          行数: rows.length,
          行: rows,
        });
      })()`,
    ),
  );
  // 点一下更新命令 —— 只能复制，绝不代跑
  await run(win, 'document.querySelector("#verRows .ver-cmd")?.click()');
  await wait(400);
  say(
    "smoke-ver-copy",
    await run(
      win,
      'JSON.stringify({ 复制反馈: !!document.querySelector("#verRows .ver-cmd.copied") })',
    ),
  );
}

/**
 * Skills 与 MCP 面板：读矩阵 → 真装一个 → 真卸掉它。
 *
 * **装卸走的是界面上真正的那条路径**（点格子），不是直接调 IPC ——
 * 中间任何一环断了（选择器写错、事件没绑上、忙标志卡住）这条冒烟都会红。
 */
async function smokeHarness(win: BrowserWindow): Promise<void> {
  await run(win, 'document.getElementById("btnHarness").click()');
  await wait(2000);
  say(
    "smoke-hx",
    await run(
      win,
      `(() => {
        const rows = document.querySelectorAll("#hxBody .hx-row:not(.hx-head)").length;
        const srcs = [...document.querySelectorAll("#hxSources .hx-src")].map(s => s.textContent.trim());
        return JSON.stringify({
          打开了: !document.getElementById("hxScrim").hidden,
          概要: document.getElementById("hxSummary").textContent,
          行数: rows,
          作用域选项: document.getElementById("hxScope").options.length,
          当前作用域: document.getElementById("hxScope").selectedOptions[0]?.textContent,
          状态条: srcs,
          可点的格子: document.querySelectorAll("#hxBody .hx-box").length,
          MCP记号: [...new Set([...document.querySelectorAll("#hxBody .hx-on,#hxBody .hx-no,#hxBody .hx-na,#hxBody .hx-unk")].map(e => e.textContent.trim()))],
        });
      })()`,
    ),
  );

  // 切到本仓库自己的目录，验项目级作用域（它有 11 个项目级 skill）
  await run(win, `(() => {
    const s = document.getElementById("hxScope");
    const opt = [...s.options].find(o => o.value.includes("multi_agents_desktop_app"));
    if (opt) { s.value = opt.value; s.dispatchEvent(new Event("change")); }
  })()`);
  await wait(2500);
  say(
    "smoke-hx-project",
    await run(
      win,
      `JSON.stringify({
        当前作用域: document.getElementById("hxScope").selectedOptions[0]?.textContent,
        概要: document.getElementById("hxSummary").textContent,
        行数: document.querySelectorAll("#hxBody .hx-row:not(.hx-head)").length,
      })`,
    ),
  );
  // 切回全局再做装卸
  await run(win, `(() => {
    const s = document.getElementById("hxScope"); s.value = ""; s.dispatchEvent(new Event("change"));
  })()`);
  await wait(2500);

  // 找一个「有的 agent 有、grok 没有」的 skill，装到 grok 再卸掉
  const before = (await run(
    win,
    `(() => {
      const box = [...document.querySelectorAll('#hxBody .hx-box[data-agent="grok"]')]
        .find(b => !b.classList.contains("on") && b.dataset.from);
      if (!box) return JSON.stringify({ 找到目标: false });
      window.__hxTarget = box.dataset.skill;
      return JSON.stringify({ 找到目标: true, skill: box.dataset.skill, 来源: box.dataset.from });
    })()`,
  )) as string;
  say("smoke-hx-target", before);

  await run(
    win,
    `document.querySelector('#hxBody .hx-box[data-agent="grok"][data-skill="' + window.__hxTarget + '"]').click()`,
  );
  await wait(3000);
  say(
    "smoke-hx-install",
    await run(
      win,
      `JSON.stringify({
        装上了: document.querySelector('#hxBody .hx-box[data-agent="grok"][data-skill="' + window.__hxTarget + '"]').classList.contains("on"),
        grok状态条: [...document.querySelectorAll("#hxSources .hx-src")].map(s=>s.textContent.trim()).find(t=>t.startsWith("grok skills")),
      })`,
    ),
  );

  // 再点一次 = 丢进回收站
  await run(
    win,
    `document.querySelector('#hxBody .hx-box[data-agent="grok"][data-skill="' + window.__hxTarget + '"]').click()`,
  );
  await wait(3000);
  say(
    "smoke-hx-uninstall",
    await run(
      win,
      `JSON.stringify({
        卸掉了: !document.querySelector('#hxBody .hx-box[data-agent="grok"][data-skill="' + window.__hxTarget + '"]').classList.contains("on"),
        grok状态条: [...document.querySelectorAll("#hxSources .hx-src")].map(s=>s.textContent.trim()).find(t=>t.startsWith("grok skills")),
        概要: document.getElementById("hxSummary").textContent,
      })`,
    ),
  );
  await run(win, 'document.getElementById("hxClose").click()');
  await wait(300);
}

/** 诊断面板：客户会复制给你的就是这段文本。 */
async function smokeDiag(win: BrowserWindow): Promise<void> {
  await run(win, 'document.getElementById("gear").click()');
  await wait(600);
  await run(win, 'document.getElementById("diagRun").click()');
  await wait(4000);
  const t = (await run(
    win,
    'JSON.stringify({ 状态: document.getElementById("diagStatus").textContent, 文本: document.getElementById("diagBox").textContent })',
  )) as string;
  const { 状态, 文本 } = JSON.parse(t) as { 状态: string; 文本: string };
  say("smoke-diag", 状态);
  process.stdout.write(`[diag-begin]
${文本}
[diag-end]
`);
}

/** 摆出各个界面状态并逐一截图。 */
async function smokeShots(win: BrowserWindow, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await wait(1500);
  // 恢复面板挡住主界面 —— 先收起来，它自己单独截一张
  await shoot(win, dir, "00-恢复面板");
  await run(win, 'document.getElementById("restoreLater")?.click()');
  await wait(500);
  await shoot(win, dir, "01-主界面");

  await run(win, 'document.getElementById("btnHistory").click()');
  await wait(Number(env("SCAN_WAIT") ?? 8000));
  await shoot(win, dir, "02-历史会话");

  await run(win, 'document.getElementById("histClose").click(); document.getElementById("gear").click()');
  await wait(600);
  await shoot(win, dir, "03-设置");

  // 摘要那块默认是收起的，收起状态看不出样式对不对 —— 展开了再截一张。
  // （`.btn-search` 完全没有 CSS 那次，就是靠截图才发现的。）
  await run(win, 'document.getElementById("sumToggle").click()');
  await wait(900);
  await run(win, 'document.getElementById("sumPeek").click()');
  await wait(2500);
  await shoot(win, dir, "03b-设置-摘要展开");
  await run(win, 'document.getElementById("sumToggle").click()');
  await wait(600);
  // Agent 版本表单独截一张 —— 它在设置里比较靠下，上面那张截不全
  await run(win, 'document.getElementById("verRows").scrollIntoView({block:"center"})');
  await wait(400);
  await shoot(win, dir, "03c-设置-Agent版本");

  await run(win, 'document.getElementById("settingsClose").click()');
  await wait(300);
  await run(win, 'document.dispatchEvent(new KeyboardEvent("keydown",{code:"F1",bubbles:true}))');
  await wait(500);
  await shoot(win, dir, "05-快捷键");
  await run(win, 'document.getElementById("keysClose").click()');
  await wait(300);
  await run(win, 'document.getElementById("btnHarness").click()');
  await wait(2500);
  await shoot(win, dir, "06-Skills与MCP");
  // MCP 区在下面，五种状态记号都在那儿 —— 单独截一张
  await run(win, `(() => {
    const h = [...document.querySelectorAll("#hxBody .hx-h")].find(e => e.textContent.startsWith("MCP"));
    h?.scrollIntoView({ block: "start" });
  })()`);
  await wait(500);
  await shoot(win, dir, "07-MCP矩阵");
  await run(win, 'document.getElementById("hxClose").click()');
  await wait(300);
  await wait(400);
  await run(win, 'document.getElementById("btnNew").click()');
  await wait(2000);
  await shoot(win, dir, "04-新建会话");
  await run(win, 'document.getElementById("newClose").click()');
  await wait(400);
}

/**
 * 铃声全链路：往真终端写一个 BEL → xterm.js 解析 → 我们的处理器 → 侧栏与标签页出现标记。
 * 再切到那个会话，标记应当被清掉。
 */
async function smokeBell(win: BrowserWindow): Promise<void> {
  // 先失焦 —— 你正盯着那个会话时按设计就不该提醒，所以要测的是"没在看"这条路径
  win.blur();
  await wait(400);
  say("smoke-bell-focus", await run(win, "String(document.hasFocus())"));
  say("smoke-bell", await run(win, "window.__agentoryRingBell()"));
  await wait(800);
  say(
    "smoke-bell-after",
    await run(
      win,
      `JSON.stringify({
        侧栏出现标记: document.querySelectorAll("#tree .pip.bell").length,
        标签页出现标记: document.querySelectorAll("#tabs .dot.bell").length,
        状态文字: [...document.querySelectorAll("#tree .state")].map((e) => e.textContent),
      })`,
    ),
  );
  // 切到那个会话，标记应当消失
  win.focus();
  await wait(300);
  await run(win, 'document.querySelector("#tabs .tab").click()');
  await wait(500);
  say(
    "smoke-bell-cleared",
    await run(
      win,
      `JSON.stringify({
        侧栏残留: document.querySelectorAll("#tree .pip.bell").length,
        标签页残留: document.querySelectorAll("#tabs .dot.bell").length,
      })`,
    ),
  );
}

/** 快捷键与右键菜单的点击路径。两者都没有单元测试能覆盖到接线这一层。 */
async function smokeKeys(win: BrowserWindow): Promise<void> {
  say(
    "smoke-keys",
    await run(
      win,
      `(() => {
        const press = (code, mods) => document.dispatchEvent(
          new KeyboardEvent("keydown", { code, bubbles: true, ...mods }));
        const out = {};
        press("F1", {});
        out["F1 开面板"] = !document.getElementById("keysScrim").hidden;
        out["面板条目数"] = document.querySelectorAll("#keysList .krow").length;
        press("F1", {});
        out["再按 F1 关掉"] = document.getElementById("keysScrim").hidden;
        press("KeyF", { ctrlKey: true, shiftKey: true });
        out["CtrlShiftF 开历史"] = !document.getElementById("histScrim").hidden;
        document.getElementById("histClose").click();
        press("KeyW", { ctrlKey: true });
        out["裸 CtrlW 未被截走"] = document.getElementById("histScrim").hidden;
        return JSON.stringify(out);
      })()`,
    ),
  );
  await wait(400);
  say(
    "smoke-ctx",
    await run(
      win,
      `(() => {
        const row = document.querySelector("#tree .sess");
        if (!row) return "侧栏没有行";
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 200 }));
        const menu = document.querySelector(".ctx");
        const items = [...document.querySelectorAll(".ctx-item")].map((b) => b.textContent);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return JSON.stringify({ 菜单出现: !!menu, 条目: items, Esc后还在: !!document.querySelector(".ctx") });
      })()`,
    ),
  );
}

/** 摘要设置：开关 → 状态 → 「看看会发送什么」渲染出真实载荷。 */
async function smokeSummary(win: BrowserWindow): Promise<void> {
  await run(win, 'document.getElementById("gear").click()');
  await wait(600);
  say(
    "smoke-sum",
    await run(
      win,
      `(() => {
        const t = document.getElementById("sumToggle");
        return JSON.stringify({ 默认: t.getAttribute("aria-pressed"),
          默认文案: document.getElementById("sumStatus").textContent });
      })()`,
    ),
  );
  // 开关走 IPC，是异步的 —— 点完要等它回来再读状态
  await run(win, 'document.getElementById("sumToggle").click()');
  await wait(1200);
  say(
    "smoke-sum-on",
    await run(
      win,
      `JSON.stringify({
        开关: document.getElementById("sumToggle").getAttribute("aria-pressed"),
        文案: document.getElementById("sumToggle").textContent,
        出现填key的框: !document.getElementById("sumKeyRow").hidden,
        动作区: !document.getElementById("sumActions").hidden,
        状态: document.getElementById("sumStatus").textContent,
      })`,
    ),
  );
  // 没有 key 时点「开跑」不会花一分钱：主进程直接回「还没有填 API key」
  await run(win, 'document.getElementById("sumRunMine").click()');
  await wait(1500);
  say(
    "smoke-sum-run",
    await run(
      win,
      `JSON.stringify({
        进度行: document.getElementById("sumProgress").textContent,
        停止键跑完收回: document.getElementById("sumStop").hidden,
      })`,
    ),
  );
  await run(win, 'document.getElementById("sumPeek").click()');
  await wait(2500);
  say(
    "smoke-sum-peek",
    await run(
      win,
      `(() => {
        const box = document.getElementById("sumPeekBox");
        const t = box.textContent || "";
        return JSON.stringify({
          展开了: !box.hidden,
          字数: t.length,
          含工具标记: /tool_result"|tool_use"/.test(t),
          开头: t.slice(0, 90),
        });
      })()`,
    ),
  );
  // 关回去，别把状态留给下一次
  await run(win, 'document.getElementById("sumToggle").click(); document.getElementById("settingsClose").click()');
  // 展开了就得能收回去 —— 只能按一次的按钮是个假开关
  await run(win, 'document.getElementById("sumPeek").click()');
  await wait(400);
  say(
    "smoke-sum-peek-close",
    await run(win, 'JSON.stringify({ 再点一次收起: document.getElementById("sumPeekBox").hidden })'),
  );
}

/** 挂上冒烟流程。`quit` 在最后一步被调用。 */
export function attachSmoke(win: BrowserWindow, quit: () => void): void {
  const delay = Number(env("DELAY") ?? 1500);

  win.webContents.once("did-finish-load", () => {
    void (async () => {
      if (env("NEW") === "1") await smokeNew(win);
      if (env("FROM_HISTORY")) await smokeFromHistory(win, Number(env("FROM_HISTORY")));
      // 主题要在截图**之前**换 —— 只在深色里好看的细节不算修好
      const shotPatch: Record<string, string> = {};
      if (env("THEME")) shotPatch["themeId"] = env("THEME")!;
      if (env("MODE")) shotPatch["mode"] = env("MODE")!;
      if (env("SHOT") && Object.keys(shotPatch).length) {
        await run(win, `window.agentory.setTheme(${JSON.stringify(shotPatch)})`);
        await wait(600);
      }
      if (env("SHOT")) await smokeShots(win, env("SHOT")!);
      if (env("FAVORITE")) await smokeFavorite(win);
      if (env("START_MEMBER") === "1") await smokeStartMember(win);
      if (env("SUMMARY") === "1") await smokeSummary(win);
      if (env("VERSIONS") === "1") await smokeVersions(win);
      if (env("HARNESS") === "1") await smokeHarness(win);
      if (env("DIAG") === "1") await smokeDiag(win);
      if (env("CLEAN") === "1") await smokeClean(win, env("CLEAN_SHOTS") ?? null);
      if (env("DPAPI")) await smokeDpapi(win, env("DPAPI")!);
      if (env("KEYS") === "1") await smokeKeys(win);
      if (env("HISTPERF") === "1") await smokeHistPerf(win);
      if (env("BELL") === "1") await smokeBell(win);
      if (env("END") === "1") await smokeEnd(win);

      const patch: Record<string, string> = {};
      if (env("THEME")) patch["themeId"] = env("THEME")!;
      if (env("MODE")) patch["mode"] = env("MODE")!;
      if (Object.keys(patch).length) {
        await run(win, `window.agentory.setTheme(${JSON.stringify(patch)})`);
      }

      await wait(delay);
      const r = (await run(
        win,
        "JSON.stringify({ check: window.__agentorySelfCheck, dump: window.__agentoryDump?.() })",
      )) as string;
      const { check, dump } = JSON.parse(r) as { check: unknown; dump?: string };
      say("smoke", JSON.stringify(check));
      process.stdout.write(`[dump-begin]\n${dump ?? "(无)"}\n[dump-end]\n`);
      quit();
    })();
  });
}
