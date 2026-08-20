import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * 断言。**这一行是这个文件从「探针」变成「测试」的分界。**
 *
 * 在这之前 25 个模式全部只有 `say()`：它们发现回归的前提是**有人逐行读输出、
 * 并且记得上次的数字是多少**。开发期那个人是存在的（几个真 bug 就是这么抓到的），
 * 发布之后不存在了 —— 于是这一千行设施等于不存在。
 *
 * 所以只加退出码，不加新设施：已经在打印的硬数字，挑不容争议的那些变成断言。
 */
const failures: string[] = [];
const check = (tag: string, ok: boolean, msg: string): void => {
  if (ok) return;
  failures.push(`${tag}：${msg}`);
  process.stdout.write(`[FAIL ${tag}] ${msg}\n`);
};

export const smokeEnabled = (): boolean => process.env["AGENTORY_SMOKE"] === "1";

/** 在渲染进程里跑一段脚本。返回值原样带回。 */
const run = (win: BrowserWindow, js: string): Promise<unknown> =>
  win.webContents.executeJavaScript(js);

/**
 * **进程会计不变量。** 主进程手上活着的 pty 数，必须等于界面说的「N 个在跑」；
 * 每个 tab 的 key 必须唯一。
 *
 * 这两条的价值在于它们**不关心是哪条路径造成的偏差**。
 * 「✕ 结束会话静默失败，25 个进程活着」那次是靠人工数进程发现的 ——
 * 这里把那个一次性动作变成常设护栏，下一个「界面以为一个、系统里两个」的
 * bug（重复恢复同一条会话、双击未启动的成员）会自己撞上来。
 *
 * 用 `parseInt` 而不是正则：文案是「3 个在跑」，`parseInt` 就够，
 * 而 `\d` 这类转义要穿过 TS 模板串再进 `executeJavaScript`，路上很容易被吃掉。
 */
async function checkAccounting(win: BrowserWindow, tag: string): Promise<void> {
  const raw = (await run(
    win,
    `JSON.stringify({
      running: parseInt(document.getElementById("runningCount").textContent, 10),
      keys: [...document.querySelectorAll("#tabs .tab")].map((t) => t.dataset.key),
      members: [...document.querySelectorAll("#tree .sess")].map((t) => t.dataset.key),
    })`,
  )) as string;
  const { running, keys, members } = JSON.parse(raw) as {
    running: number;
    keys: string[];
    members: string[];
  };
  const pids = livePids();
  check(
    `会计-${tag}`,
    pids.length === running,
    `主进程 ${pids.length} 个 pty，界面说 ${String(running)} 个在跑`,
  );
  check(
    `会计-${tag}`,
    new Set(keys).size === keys.length,
    `tab 的 key 有重复（同一条会话开了两个）：${keys.join(" | ")}`,
  );
  /**
   * **侧栏成员的 key 也必须唯一。**
   *
   * key 是工作集主键，而 `viewOf` 是 `views.find(v => v.key === key)` —— 返回**第一个**。
   * 两个成员同 key 时，点第二个的 ✕ 会去结束第一个：进程还活着、标签页还在，
   * 而用户看到的是「我点的那一行没了」。
   *
   * 这件事真的发生过（END 那一刀偶发红，4 个成员时才出现）：
   * 新建会话的 key 是 `claude|cwd:<目录>`（sessionId 为 null），
   * **同一个目录再新建一次就是同一个 key**。
   */
  check(
    `会计-${tag}`,
    new Set(members).size === members.length,
    `侧栏成员的 key 有重复（✕ 会结束错的那个）：${members.join(" | ")}`,
  );
}

/** 走「新建会话」的完整点击路径：开选择器 → 选 agent → 填目录 → 按开始。 */
async function smokeNew(win: BrowserWindow): Promise<void> {
  /**
   * 默认起在一个**每次都新建的临时目录**里，而不是 `process.cwd()`。
   *
   * 原来是后者，于是这个模式跨运行不幂等：工作集里会留下一条
   * `claude|cwd:<项目目录>`，下一次再跑就撞上「同目录同 agent 只能有一条」的守卫，
   * 报一个和被测行为无关的红。
   */
  const dir = JSON.stringify(env("NEW_CWD") ?? mkdtempSync(join(tmpdir(), "agentory-smoke-new-")));
  await run(win, 'document.getElementById("btnNew").click()');
  await wait(2500);
  const clicked = String(
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
  say("smoke-new", clicked);
  check("new", clicked.startsWith("已点击开始"), clicked);

  await wait(3000);
  const raw = (await run(
    win,
    `JSON.stringify({
      errShown: !document.getElementById("newError").hidden,
      errText: document.getElementById("newError").textContent,
      pickerStillOpen: !document.getElementById("newScrim").hidden,
      tabs: document.querySelectorAll("#tabs .tab").length,
      空态还在: !document.getElementById("termEmpty").hidden,
    })`,
  )) as string;
  say("smoke-new-after", raw);
  const a = JSON.parse(raw) as { errShown: boolean; errText: string; pickerStillOpen: boolean; tabs: number };
  check("new", !a.errShown, `新建会话报错：${a.errText}`);
  check("new", !a.pickerStillOpen, "点了开始，选择器还开着");
  check("new", a.tabs >= 1, "点了开始，一个 tab 都没出现");
}

/**
 * **五个 agent 各起一次，在真 Electron 里。**
 *
 * `terminal/resolve.ts` 自己写着：那几个用 `process.execPath` 的单元测试证明不了这件事，
 * 因为它们在 vitest 下跑，那里 `execPath` 就是 node。而「codex / pi 被解析成
 * `electron.exe`，在应用里根本起不来」正是这样漏过去的 ——
 * 它当时唯一的守卫是「有人打开诊断面板读那七行路径」。
 *
 * 五个 agent 共用一个临时目录：主键是 `(agent, cwd)`，agent 各不相同就不会撞。
 */
async function smokeNewAll(win: BrowserWindow): Promise<void> {
  const dir = JSON.stringify(env("NEW_CWD") ?? mkdtempSync(join(tmpdir(), "agentory-smoke-all-")));
  const agents = JSON.parse(
    (await run(
      win,
      `(async () => {
        document.getElementById("btnNew").click();
        await new Promise((r) => setTimeout(r, 2500));
        return JSON.stringify([...document.querySelectorAll("#newAgents button")].map((b) => b.dataset.agent));
      })()`,
    )) as string,
  ) as string[];
  say("smoke-all-agents", JSON.stringify(agents));
  check("all-agents", agents.length === 5, `新建面板里只有 ${agents.length} 个 agent 可选：${agents.join()}`);

  for (const a of agents) {
    const r = String(
      await run(
        win,
        `(async () => {
          if (document.getElementById("newScrim").hidden) document.getElementById("btnNew").click();
          /**
           * **轮询等 chip 出现，不能同步就找。** chip 是 launchOptions() 的 promise
           * 回来之后才填的；上一个 agent 起成功会把选择器关掉，重新点开时它又是空的。
           * 第一版是同步找，结果 codex 和 pi 隔一个失败一次 —— 那是测试的 bug，不是应用的。
           */
          const deadline = Date.now() + 8000;
          let chip = null;
          while (Date.now() < deadline) {
            chip = [...document.querySelectorAll("#newAgents button")].find((b) => b.dataset.agent === ${JSON.stringify(a)});
            if (chip) break;
            await new Promise((r) => setTimeout(r, 200));
          }
          if (!chip) return "等了 8 秒也没等到 chip";
          chip.click();
          const box = document.getElementById("newCwd");
          box.value = ${dir};
          box.dispatchEvent(new Event("input"));
          const go = document.getElementById("newGo");
          if (go.disabled) return "开始键不可用";
          go.click();
          return "ok";
        })()`,
      ),
    );
    check(`all-${a}`, r === "ok", `${a}：${r}`);
    await wait(Number(env("ALL_WAIT") ?? 9000));
    const after = (await run(
      win,
      `JSON.stringify({
        err: document.getElementById("newError").hidden ? "" : document.getElementById("newError").textContent,
        tabs: document.querySelectorAll("#tabs .tab").length,
      })`,
    )) as string;
    const s = JSON.parse(after) as { err: string; tabs: number };
    say(`smoke-all-${a}`, after);
    check(`all-${a}`, s.err === "", `${a} 启动报错：${s.err}`);
  }

  // 五个都还在。终端里到底有没有内容，看 `[dump-begin]` 那段 —— 它已经逐个转出来了
  const tabs = JSON.parse(
    (await run(win, `JSON.stringify([...document.querySelectorAll("#tabs .tab")].map((t) => t.dataset.key))`)) as string,
  ) as string[];
  say("smoke-all-tabs", JSON.stringify(tabs));
  check("all-agents", tabs.length === agents.length, `起了 ${agents.length} 个，只剩 ${tabs.length} 个标签页`);
}

/**
 * 走「从历史恢复」的点击路径：开历史 → 用搜索框缩小 → 点前 n 条。
 *
 * 用真实的搜索框而不是另加一套选择参数 —— 少一条只在测试里存在的代码路径。
 */
async function smokeFromHistory(win: BrowserWindow, spec: string): Promise<void> {
  const filter = JSON.stringify(env("HISTORY_FILTER") ?? "");
  /**
   * `FROM_HISTORY=dup`：点**同一条**两次（间隔 200ms，第一次还在恢复中）。
   *
   * 默认那条路径点的是 `rows.slice(0, n)` —— **n 条不同的行**，
   * 所以它结构上永远碰不到「同一条会话被恢复两次」。而那正是要复现的形状：
   * 两个 pty 同时往同一个会话文件里追加。
   */
  const dup = spec === "dup";
  const n = dup ? 0 : Number(spec);
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
        const picked = ${dup ? "(rows[0] ? [rows[0]] : [])" : `rows.slice(0, ${n})`};
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
  if (dup) {
    // 第一次还在恢复中就再点一次 —— 会计不变量在收尾时判它
    await wait(200);
    say(
      "smoke-hist-dup",
      await run(
        win,
        `(() => {
          const row = [...document.querySelectorAll("#histList .hist-row")]
            .filter((r) => r.dataset.dead !== "1")[0];
          if (!row) return "没有可点第二次的行";
          row.click();
          return "同一条又点了一次：" + row.querySelector(".cwd").textContent;
        })()`,
      ),
    );
  }
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
  // `START_MEMBER=double`：点两下。`activate()` 里原本没有任何在途标志
  // （对比 `resumeGo` 是有的），而 agent 起来要几秒 —— 双击稳稳落在那个窗口里。
  const double = env("START_MEMBER") === "double";
  const started = String(
    await run(
      win,
      `(() => {
        const rows = [...document.querySelectorAll("#tree .sess")];
        // 文案从「未启动」改成了「点击恢复」（shell.ts 的 stateText 有说明）。
        // 这是全仓库唯一一处**行为上**依赖这个字面量的地方，其余命中都是注释。
        const target = rows.find((r) => r.querySelector(".state").textContent === "点击恢复");
        if (!target) return "侧栏里没有可恢复的成员";
        target.click();
        ${double ? "target.click();" : ""}
        return "已点击：" + target.querySelector(".cmd").textContent.trim();
      })()`,
    ),
  );
  say("smoke-start", started);
  check("start-member", started.startsWith("已点击"), started);
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

  if (env("FAVORITE") === "open" || env("FAVORITE") === "open2") {
    // 点收藏项 = 恢复进工作集，与点「未启动的成员」同一条路径 ——
    // 所以 `open2`（点两下）验的是同一个在途标志，只是从第三个入口进
    const twice = env("FAVORITE") === "open2";
    say(
      "smoke-fav-open",
      await run(
        win,
        `(() => {
          const r = document.querySelector("#favTree .sess.fav");
          if (!r) return "收藏区里没有可点的条目";
          r.click();
          ${twice ? "r.click();" : ""}
          return "已点击${twice ? "两次" : ""}：" + r.querySelector(".sum").textContent.trim();
        })()`,
      ),
    );
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

  const ended = String(
    await run(
      win,
      `(() => {
        const rows = [...document.querySelectorAll("#tree .sess")];
        const states = rows.map((r) => r.querySelector(".state").textContent);
        // 必须精确挑一个在跑的。原本是 querySelector 取第一个 .end —— 工作集里攒了
        // 旧成员之后点到的是它们，移出工作集不杀任何进程，于是「整树消失 0 棵」
        // 既是真的又毫无意义。这个模式一直隐含假设「工作集里只有一个成员」。
        // 用白名单而不是「不等于未启动」：状态有四种（工作中/未启动/已停/需要你），
        // 「已停」也不是「未启动」，一样会被选中；响铃时「工作中」会被改写成「需要你」。
        const i = states.findIndex((s) => s === "工作中" || s === "需要你");
        if (i < 0) return "侧栏里没有在跑的会话可结束，各成员状态：" + states.join("/");
        // 把点中的那一行的身份打出来。不打的话，一次失败只能看到「整树消失 0 棵」，
        // 分不清是「漏杀」还是「压根点错了行」—— 那两件事的修法完全相反。
        const key = rows[i].dataset.key;
        rows[i].querySelector(".end").click();
        return JSON.stringify({
          成员数: rows.length,
          各成员状态: states,
          点中第几个: i,
          点中的key: key,
        });
      })()`,
    ),
  );
  say("smoke-end", ended);
  check("end", ended.startsWith("{"), ended);
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
  // 通过的形态是**恰好一棵**：0 棵 = 漏杀（就是「25 个进程活着」那次），
  // 多于 1 棵 = 点一个 ✕ 连坐了别人
  if (before.length > 0) {
    check("end", wiped.length === 1, `整树消失 ${wiped.length} 棵，应为 1：${JSON.stringify(after)}`);
  }
  say(
    "smoke-end-after",
    await run(
      win,
      `JSON.stringify({
        members: document.querySelectorAll("#tree .sess").length,
        tabs: document.querySelectorAll("#tabs .tab").length,
        剩下的key: [...document.querySelectorAll("#tree .sess")].map((r) => r.dataset.key),
        侧栏报错: document.getElementById("sideNote").hidden ? null : document.getElementById("sideNote").textContent,
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
  /**
   * **每张图自报当前最上层是什么。**
   *
   * 这一步之前，`shoot()` 从不检查自己要拍的东西在不在屏幕上 —— 某次上一步的
   * 关闭动作没生效，接下来两张图拍的都还是上一屏，而文件名照旧。
   * 实测撞到过：`07-MCP矩阵.png` 里装的是快捷键面板，日志一片绿。
   *
   * **文件名说谎的截图比没有截图更糟** —— 评审会照着它下结论（我就下过）。
   * 不做「名字与内容必须匹配」的强断言（那要维护一张映射表），
   * 只把实际状态打出来：让说谎的那一张在日志里就看得出来。
   */
  const top = String(
    await run(
      win,
      `(() => {
        const open = [...document.querySelectorAll(".scrim")].filter((s) => !s.hidden).map((s) => s.id);
        return open.length ? open.join("+") : "(主界面)";
      })()`,
    ),
  );
  const img = await win.capturePage();
  const file = join(dir, `${name}.png`);
  writeFileSync(file, img.toPNG());
  say("smoke-shot", `${name} → ${img.getSize().width}×${img.getSize().height}  最上层：${top}`);
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

  /**
   * **没有可装的目标就到此为止，不要接着点 null。**
   *
   * 装卸这一段的前置条件是「至少有一个 skill，而 grok 还没有它」。一台空机器上
   * 那个条件不成立，`找到目标: false`，而下一行照样 `querySelector(...).click()`
   * → `Cannot read properties of null` → 整个冒烟抛错。
   *
   * 这是今天第三次撞上同一个形状（`smokeBell` 没有标签页、`smokeEnd` 没有在跑的会话）：
   * **冒烟里的前置条件不成立时崩掉，而不是说出来。** 前提说清楚比抛错有用得多。
   */
  if (!(JSON.parse(before) as { 找到目标: boolean }).找到目标) {
    check("harness", false, "没有可装的 skill（grok 已经全有了，或者这台机器一个 skill 都没有）—— 装卸这一段跳过");
    return;
  }

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
  // 把这一屏的实际状态打出来，别只留一张图 —— 图要人看，这一行 grep 就行。
  // 摘要区是「冒烟全绿而界面是错的」的高发区（三个按钮的禁用态没有样式那次）。
  say(
    "smoke-shot-sum",
    await run(
      win,
      `JSON.stringify({
        开关: document.getElementById("sumToggle").textContent,
        keyRow隐藏: document.getElementById("sumKeyRow").hidden,
        动作区隐藏: document.getElementById("sumActions").hidden,
        看看会发送什么可点: !document.getElementById("sumPeek").disabled,
        两个生成键禁用: document.getElementById("sumRunMine").disabled && document.getElementById("sumRunAll").disabled,
        状态行: document.getElementById("sumStatus").textContent,
      })`,
    ),
  );
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
  /**
   * 右键菜单。**这一张是补的** —— 这个组件刚一次性暴露了两个问题：
   * 鼠标点不动（从第一天起），以及「危险」项用 `--c-dim` 表达、看起来像禁用。
   * 后者只有看图才发现得了。
   */
  await run(
    win,
    `(() => {
      const row = document.querySelector("#tree .sess");
      if (row) row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 150, clientY: 240 }));
    })()`,
  );
  await wait(500);
  await shoot(win, dir, "10-右键菜单");
  await run(win, 'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await wait(300);

  await run(win, 'document.getElementById("btnNew").click()');
  await wait(2000);
  await shoot(win, dir, "04-新建会话");
  await run(win, 'document.getElementById("newClose").click()');
  await wait(400);

  /**
   * 这一刀新加的两块界面：侧栏报错位、历史里的「有来源没读出来」。
   *
   * **文字是注入的**，因为这两个状态在一台好机器上不会自然出现
   * （`verify:broken` 那边有真的 `#sideNote`）。这里要看的是**样式对不对** ——
   * 对齐、留白、换行、在两种主题下的对比度。`.btn-search` 完全没有 CSS 那次
   * 就是这么发现的：冒烟全绿，界面是错的。
   */
  await run(
    win,
    `(() => {
      const s = document.getElementById("sideNote");
      s.hidden = false;
      s.textContent = "没能启动：工作目录不存在或不是目录：C:\\\\Users\\\\PC\\\\Desktop\\\\一个已经被删掉的很长的项目目录名";
    })()`,
  );
  await wait(400);
  await shoot(win, dir, "08-侧栏报错位");

  await run(win, 'document.getElementById("btnHistory").click()');
  // **注入必须在扫描回来之后。** 第一版是先注入再等扫描，而扫描的 .then 里
  // `histProblems.hidden = r.problems.length === 0` 又把它关上了 ——
  // 截出来的图里那一条根本不在。冒烟当时是全绿的。
  await wait(Number(env("SCAN_WAIT") ?? 8000));
  await run(
    win,
    `(() => {
      const p = document.getElementById("histProblems");
      p.hidden = false;
      p.textContent = "有 1 个来源没读出来：[opencode] 扫描失败：database is locked";
    })()`,
  );
  await wait(400);
  await shoot(win, dir, "09-历史-读不出的来源");
  await run(win, 'document.getElementById("histClose").click()');
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
  // 没有标签页时原本是 `querySelector(...).click()` → TypeError → 整个冒烟挂死。
  // 这个模式要求先有一个在跑的会话，说清楚比抛错强。
  const clicked = String(
    await run(
      win,
      `(() => {
        const t = document.querySelector("#tabs .tab");
        if (!t) return "没有标签页 —— BELL 模式要先有一个在跑的会话（配合 NEW=1）";
        t.click();
        return "已切到该会话";
      })()`,
    ),
  );
  check("bell", clicked === "已切到该会话", clicked);
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

/**
 * 「坏机器」上界面说的话（配合 `scripts/verify-broken.cjs`）。
 *
 * 跑在 `START_MEMBER` 之后 —— 那一击点的是唯一一个成员，而它的工作目录已经被删了，
 * 所以它**必然失败**。要验的就是：失败之后界面到底说没说。
 */
async function smokeBroken(win: BrowserWindow): Promise<void> {
  const raw = (await run(
    win,
    `JSON.stringify({
      侧栏报错可见: !document.getElementById("sideNote").hidden,
      侧栏报错: document.getElementById("sideNote").textContent,
      成员数: document.querySelectorAll("#tree .sess").length,
      标签页数: document.querySelectorAll("#tabs .tab").length,
      在跑: document.getElementById("runningCount").textContent,
    })`,
  )) as string;
  say("smoke-broken", raw);
  const b = JSON.parse(raw) as { 侧栏报错可见: boolean; 侧栏报错: string; 标签页数: number };
  // 这是这一击的全部意义：点一个起不来的会话，不能什么都不说
  check("broken", b.侧栏报错可见, "点了一个工作目录已删的成员，启动失败，侧栏一个字都没说");
  check("broken", b.侧栏报错.length > 0, "报错位可见但内容是空的");
  check("broken", b.标签页数 === 0, `启动失败却开出了 ${b.标签页数} 个标签页`);
}

/**
 * 缩放键。**必须用 `sendInputEvent` 而不是 `dispatchEvent`** ——
 * Chromium 的整页缩放是在输入管线里处理的，渲染层合成的 KeyboardEvent 根本触发不到它，
 * 那样测出来的「没缩放」是假的。
 */
async function smokeZoom(win: BrowserWindow): Promise<void> {
  /**
   * `ZOOM=poison`：把缩放写进 userData 然后优雅退出（`app.exit` 不刷偏好，必须 `app.quit`）。
   *
   * ⚠️ **这条守不住那次事故，别把它当护栏。** 实测：
   * 毒确实落盘了（`Preferences` 里能看到 `-4.5`），但**把修复临时去掉之后
   * 同一份 profile 跑出来仍然是 `zoomFactor=1`** —— 也就是说它没能复现用户那个
   * 卡住的状态，因此也证明不了自己能抓住它。
   *
   * 留着是因为它仍然在验一件真事：**启动时整页缩放必须是 1**。
   * 但那次事故（用户升级后卡在 0.44、而退路又被改绑堵死）的复现条件我还没找到，
   * 如实记在这里而不是假装有守卫 —— 一个证明不了自己的测试比没有更危险。
   *
   * 事故本身的根因是确认过的：Chromium 把 zoom 持久化在
   * `Preferences` 的 `partition.per_host_zoom_levels`，而我此前每次验证都用
   * 全新的 `--user-data-dir`，**那恰恰把持久化这件事藏了起来**。
   */
  if (env("ZOOM") === "poison") {
    win.webContents.setZoomLevel(-4.5);
    await wait(600);
    say("smoke-zoom-poison", `已把 zoomLevel 写成 -4.5（factor=${win.webContents.getZoomFactor().toFixed(2)}）`);
    return;
  }

  const press = async (keyCode: string, n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["control"] });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["control"] });
      await wait(150);
    }
  };
  const z = (): number => Math.round(win.webContents.getZoomFactor() * 100) / 100;

  /** 终端实例上的真实字号 —— 不读我们自己的 state，那只能证明「存下了」。 */
  const size = async (): Promise<number | null> =>
    JSON.parse(
      (await run(win, "JSON.stringify(window.__agentoryFontState?.() ?? {})")) as string,
    ).termFontSize ?? null;

  const before = await size();
  say("smoke-zoom-start", `zoomFactor=${z()}  终端字号=${String(before)}`);
  await press("-", 3);
  const afterMinus = z();
  const sizeMinus = await size();
  say("smoke-zoom-minus", `Ctrl+- ×3 → zoomFactor=${afterMinus}  终端字号=${String(sizeMinus)}`);
  await press("=", 3);
  const afterPlus = z();
  const sizePlus = await size();
  say("smoke-zoom-plus", `Ctrl+= ×3 → zoomFactor=${afterPlus}  终端字号=${String(sizePlus)}`);

  /**
   * **减 3 再加 3 回到原点，这一条本身证明不了字号动过。** 所以要验中间值：
   * 有终端时字号必须真的降下去再升回来；没终端时跳过（那不是失败）。
   */
  if (before !== null) {
    check("zoom", sizeMinus === before - 3, `Ctrl+- ×3 之后终端字号是 ${String(sizeMinus)}，应为 ${before - 3}`);
    check("zoom", sizePlus === before, `Ctrl+= ×3 之后终端字号是 ${String(sizePlus)}，应回到 ${before}`);
  }

  /**
   * **整页缩放必须恒为 1。** 它把布局一起缩，而原生窗口控件（最小化/最大化/关闭）
   * 不跟着缩 —— 用户截图里那对巨大的窗口按钮就是这么来的。
   * 我们要的是「调字号」，不是「把网页缩小」。
   */
  check("zoom", afterMinus === 1, `Ctrl+- 把整页缩放改成了 ${afterMinus}`);
  check("zoom", afterPlus === 1, `Ctrl+= 把整页缩放改成了 ${afterPlus}`);

  // 本机探测到的等宽字体。下拉里只该出现真装了的 —— 选一个没装的会静默退回
  const fonts = JSON.parse(
    (await run(
      win,
      `JSON.stringify((window.__agentoryFontState?.().fonts ?? []).filter((f) => f.mono).map((f) => f.name))`,
    )) as string,
  ) as string[];
  say("smoke-zoom-fonts", `本机 ${fonts.length} 个：${fonts.join(" | ")}`);
  check("zoom", fonts.length > 0, "一个等宽字体都没探测到 —— 下拉会是空的");
}

/**
 * `UPDATE=<agent>`：真的点一次「更新」，等它跑完，看版本号有没有变。
 *
 * **这条只能真跑** —— 它验的是「停会话 → 覆盖磁盘上的包 → 版本真的变了 → 会话回来」，
 * 每一环都在文件系统和进程层面，没有一环能用桩件代替。
 */
async function smokeUpdate(win: BrowserWindow, agent: string): Promise<void> {
  await run(win, 'document.getElementById("gear").click()');
  await wait(3000);

  const before = String(
    await run(
      win,
      `(() => {
        const row = [...document.querySelectorAll("#verRows .ver-row")].find((r) => r.querySelector(".ver-name")?.textContent === ${JSON.stringify(agent)});
        if (!row) return "没有这一行";
        const btn = row.querySelector('[data-update]');
        return JSON.stringify({ 版本列: row.querySelector(".ver-num")?.textContent?.trim(), 有更新按钮: !!btn });
      })()`,
    ),
  );
  say("smoke-update-before", before);
  if (!before.includes('"有更新按钮":true')) {
    check("update", false, `${agent} 那一行没有「更新」按钮（可能本来就是最新版）：${before}`);
    return;
  }

  await run(
    win,
    `document.querySelector('#verRows [data-update="${agent}"]').click()`,
  );

  // npm 装一个包可能要一分钟以上；轮询到状态行不再是「正在…」
  const deadline = Date.now() + 240_000;
  let status = "";
  while (Date.now() < deadline) {
    await wait(3000);
    status = String(await run(win, 'document.getElementById("verStatus").textContent'));
    if (!status.includes("正在")) break;
  }
  say("smoke-update-status", status);

  const after = String(
    await run(
      win,
      `(() => {
        const row = [...document.querySelectorAll("#verRows .ver-row")].find((r) => r.querySelector(".ver-name")?.textContent === ${JSON.stringify(agent)});
        return JSON.stringify({
          版本列: row?.querySelector(".ver-num")?.textContent?.trim(),
          还有更新按钮: !!row?.querySelector("[data-update]"),
          临时面板还在: [...document.querySelectorAll("#tabs .tab")].some((t) => t.dataset.key?.startsWith("更新|")),
        });
      })()`,
    ),
  );
  say("smoke-update-after", after);
  // **只信版本号**：退出码 0 不等于装成功
  check("update", status.includes("已更新"), `更新没走到「已更新」：${status}`);
  check("update", !after.includes('"还有更新按钮":true'), `版本没变，更新按钮还在：${after}`);
}

/**
 * `SUMEXPAND=1`：摘要能不能在应用里读全，以及读到的是不是同一份。
 *
 * 三件事一次验完，它们是同一个故事的三个根因：
 *
 * 1. **同一个会话在侧栏只能有一段字。** 工作集那行曾经走「加入时持久化的快照 +
 *    启动时一次性覆盖」，而收藏和历史是每次渲染实时查 —— 于是同一个 session id
 *    在同一个侧栏里显示两段不同的文本。
 * 2. **右键「复制摘要」复制的必须是界面上那一份。** 它曾经读的是那个陈旧快照，
 *    用户复制出来是半句话。
 * 3. **点摘要展开，且绝不能把会话启起来。** `.sess` 整行是个 button，
 *    `.sum` 在它里面 —— 漏了 `stopPropagation` 就变成「每想读一次摘要就起一个 agent 进程」。
 *
 * ⚠️ 展开那一下**必须用 `sendInputEvent`**。这个文件里已经栽过两次：
 * 缩放（整页缩放在输入管线里处理）和右键菜单（元素脱离文档后合成事件照样触发委托）。
 * `dispatchEvent` 复现不了真实鼠标。
 */
async function smokeSumExpand(win: BrowserWindow): Promise<void> {
  const dump = async (): Promise<{
    工作集: { key: string; sid: string; 文本: string }[];
    收藏: { key: string; sid: string; 文本: string }[];
    标签页: number;
  }> =>
    JSON.parse(
      (await run(
        win,
        `(() => {
          const rows = (sel, attr) => [...document.querySelectorAll(sel)].map((r) => ({
            key: r.dataset[attr],
            sid: r.querySelector(".sid")?.textContent ?? "",
            文本: r.querySelector(".sum")?.textContent ?? "",
          }));
          return JSON.stringify({
            工作集: rows("#tree .sess", "key"),
            收藏: rows("#favTree .sess", "fav"),
            标签页: document.querySelectorAll("#tabs .tab").length,
          });
        })()`,
      )) as string,
    ) as never;

  const d = await dump();
  say("smoke-sum-rows", JSON.stringify(d));

  // ① 同一个 session 在两处的文本必须一致
  const pairs = d.工作集
    .map((w) => ({ w, f: d.收藏.find((x) => x.sid === w.sid && x.sid !== "") }))
    .filter((p) => p.f !== undefined);
  if (pairs.length === 0) {
    say("smoke-sum-same", "工作集和收藏没有同一个会话，跳过「两处一致」这条");
  } else {
    for (const { w, f } of pairs) {
      say("smoke-sum-same", JSON.stringify({ sid: w.sid, 工作集: w.文本, 收藏: f!.文本 }));
      check(
        "sumexpand",
        w.文本 === f!.文本,
        `同一个会话 ${w.sid} 在侧栏有两段字：工作集「${w.文本}」/ 收藏「${f!.文本}」`,
      );
    }
  }

  const first = d.工作集[0];
  if (!first) {
    check("sumexpand", false, "侧栏一行都没有，验不了");
    return;
  }

  // ② 右键「复制摘要」复制的必须是界面上显示的那一份
  const menuAt = JSON.parse(
    (await run(
      win,
      `(async () => {
        const row = document.querySelector("#tree .sess");
        await navigator.clipboard.writeText("__哨兵__").catch(() => {});
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 200 }));
        const btn = [...document.querySelectorAll(".ctx-item")].find((b) => b.textContent.includes("复制摘要"));
        if (!btn) return JSON.stringify({ err: "菜单里没有「复制摘要」" });
        const r = btn.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`,
    )) as string,
  ) as { x?: number; y?: number; err?: string };

  if (menuAt.err !== undefined) {
    check("sumexpand", false, menuAt.err);
  } else {
    const at = { x: menuAt.x!, y: menuAt.y!, button: "left" as const, clickCount: 1 };
    win.webContents.sendInputEvent({ type: "mouseDown", ...at });
    win.webContents.sendInputEvent({ type: "mouseUp", ...at });
    await wait(500);
    const copied = String(
      await run(win, `navigator.clipboard.readText().catch(() => "(读不到)")`),
    );
    say(
      "smoke-sum-copy",
      JSON.stringify({ 剪贴板长度: copied.length, 界面长度: first.文本.length, 剪贴板: copied }),
    );
    check("sumexpand", copied !== "__哨兵__", "点了「复制摘要」剪贴板没变");
    check(
      "sumexpand",
      copied === first.文本,
      `复制到的和界面显示的不是同一份：剪贴板 ${copied.length} 字「${copied}」，界面 ${first.文本.length} 字「${first.文本}」`,
    );
  }

  // ③ 真鼠标点摘要 → 展开，且不许启动会话
  const pidsBefore = livePids().length;
  const box = JSON.parse(
    (await run(
      win,
      `(() => {
        const el = document.querySelector("#tree .sess .sum");
        if (!el) return JSON.stringify({ err: "没有 .sum" });
        const r = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
          clientH: el.clientHeight, scrollH: el.scrollHeight, 展开着: el.classList.contains("expanded"),
        });
      })()`,
    )) as string,
  ) as { x?: number; y?: number; clientH?: number; scrollH?: number; 展开着?: boolean; err?: string };

  if (box.err !== undefined) {
    check("sumexpand", false, box.err);
    return;
  }
  say("smoke-sum-before", JSON.stringify(box));
  // `SUMEXPAND_SHOTS=<目录>`：收起态和展开态各一张。这一刀改的是**看得见的东西**，
  // 而冒烟读的是 class 和 scrollHeight —— 那两个绿了不等于人眼看着是对的
  const shots = env("SUMEXPAND_SHOTS");
  if (shots !== undefined) {
    mkdirSync(shots, { recursive: true }); // `shoot()` 不自己建目录
    await shoot(win, shots, "摘要-收起");
  }

  const hit = { x: box.x!, y: box.y!, button: "left" as const, clickCount: 1 };
  win.webContents.sendInputEvent({ type: "mouseDown", ...hit });
  win.webContents.sendInputEvent({ type: "mouseUp", ...hit });
  await wait(600);

  const after = JSON.parse(
    (await run(
      win,
      `(() => {
        const el = document.querySelector("#tree .sess .sum");
        const key = el.dataset.expand;
        const twin = document.querySelector('#favTree [data-expand="' + CSS.escape(key) + '"]');
        return JSON.stringify({
          展开着: el.classList.contains("expanded"),
          clientH: el.clientHeight, scrollH: el.scrollHeight,
          标签页: document.querySelectorAll("#tabs .tab").length,
          收藏里同一条: twin === null ? "没有" : String(twin.classList.contains("expanded")),
        });
      })()`,
    )) as string,
  ) as { 展开着: boolean; clientH: number; scrollH: number; 标签页: number; 收藏里同一条: string };
  const pidsAfter = livePids().length;
  say("smoke-sum-after", JSON.stringify({ ...after, pty前: pidsBefore, pty后: pidsAfter }));
  if (shots !== undefined) await shoot(win, shots, "摘要-展开");

  check("sumexpand", after.展开着, "真鼠标点了 .sum，没有拿到 expanded 类");
  check(
    "sumexpand",
    after.clientH >= after.scrollH,
    `展开之后还是被截着：clientHeight=${after.clientH} < scrollHeight=${after.scrollH}`,
  );
  // 这两条是 stopPropagation 的守卫。漏了就是「想读一眼摘要，起了一个 agent 进程」
  check("sumexpand", pidsAfter === pidsBefore, `点摘要把会话启起来了：pty ${pidsBefore} → ${pidsAfter}`);
  check("sumexpand", after.标签页 === d.标签页, `点摘要多开了标签页：${d.标签页} → ${after.标签页}`);
  // 展开状态按 `agent|sessionId` 存，工作集和收藏共用一个集合 —— 同一个会话在两处
  // 是同一件事。**断言它**，不能只打印：只 say 不 check 的字段钉不住任何东西
  if (after.收藏里同一条 !== "没有") {
    check("sumexpand", after.收藏里同一条 === "true", "工作集展开了，收藏里同一个会话没跟着展开");
  }

  // ④ 再点一次收起 —— 只展不收就是个单向门
  win.webContents.sendInputEvent({ type: "mouseDown", ...hit });
  win.webContents.sendInputEvent({ type: "mouseUp", ...hit });
  await wait(600);
  const back = String(
    await run(win, `String(document.querySelector("#tree .sess .sum").classList.contains("expanded"))`),
  );
  say("smoke-sum-collapse", `再点一次 → 展开着=${back}`);
  check("sumexpand", back === "false", "再点一次没有收起来");

  /**
   * ⑤ 收藏那一侧是**另一个 click 委托**，得单独点一次。
   * 两处的接线是分开写的，只验一处就等于放着另一处不管 ——
   * 这个文件里所有的坑都长在「没测到的那一处接线」上。
   */
  const favAt = JSON.parse(
    (await run(
      win,
      `(() => {
        const el = document.querySelector("#favTree .sess .sum[data-expand]");
        if (!el) return JSON.stringify({ err: "收藏区没有可展开的摘要" });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`,
    )) as string,
  ) as { x?: number; y?: number; err?: string };

  if (favAt.err !== undefined) {
    say("smoke-sum-fav", favAt.err);
    return;
  }
  const favPids = livePids().length;
  const favHit = { x: favAt.x!, y: favAt.y!, button: "left" as const, clickCount: 1 };
  win.webContents.sendInputEvent({ type: "mouseDown", ...favHit });
  win.webContents.sendInputEvent({ type: "mouseUp", ...favHit });
  await wait(600);
  const favAfter = JSON.parse(
    (await run(
      win,
      `(() => {
        const el = document.querySelector("#favTree .sess .sum[data-expand]");
        return JSON.stringify({
          展开着: el.classList.contains("expanded"),
          标签页: document.querySelectorAll("#tabs .tab").length,
        });
      })()`,
    )) as string,
  ) as { 展开着: boolean; 标签页: number };
  say("smoke-sum-fav", JSON.stringify({ ...favAfter, pty前: favPids, pty后: livePids().length }));
  check("sumexpand", favAfter.展开着, "点收藏里的摘要没有展开");
  check("sumexpand", livePids().length === favPids, "点收藏里的摘要把会话恢复起来了");
  check("sumexpand", favAfter.标签页 === d.标签页, "点收藏里的摘要多开了标签页");
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

  /**
   * **真的点一项，并断言副作用发生了。**
   *
   * 上面那一段只验「菜单出现 → 列出条目 → Esc 关掉」——
   * 而这个文件的注释写着它验的是「右键菜单的**点击路径**」，那句话是假的。
   * 恰恰是缺的这一步让一个**从第一天就存在**的 bug 活了一周：
   * `menu.ts` 在 window 的捕获阶段无条件 `pointerdown → closeMenu()`，
   * 按钮在 click 派发之前就被移出 DOM，于是**所有菜单项用鼠标点都没反应**。
   *
   * 拿「复制工作目录」当探针：它的副作用可以从渲染层读回来（剪贴板），
   * 而且不改变任何状态 —— 不像「结束会话」那样跑一次就把环境弄没了。
   */
  /**
   * ⚠️ **必须用 `sendInputEvent`，不能用 `dispatchEvent`。**
   *
   * 第一版用了合成 DOM 事件，结果**测不出这个 bug**：`pointerdown` 把菜单从
   * document 里摘走之后，按钮仍然是 box 的子节点（只是脱离了文档），
   * 于是挂在 box 上的委托照样触发 —— 而**真实鼠标不会这样**，元素没了
   * 浏览器根本不会给它派发 click。合成事件复现不了输入管线的行为。
   * （缩放那一刀刚栽过同一个跟头。）
   */
  const rect = JSON.parse(
    (await run(
      win,
      `(async () => {
        const row = document.querySelector("#tree .sess");
        if (!row) return JSON.stringify({ err: "侧栏没有行" });
        await navigator.clipboard.writeText("__哨兵__").catch(() => {});
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 200 }));
        const btn = [...document.querySelectorAll(".ctx-item")].find((b) => b.textContent.includes("复制工作目录"));
        if (!btn) return JSON.stringify({ err: "菜单里没有「复制工作目录」" });
        const r = btn.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`,
    )) as string,
  ) as { x?: number; y?: number; err?: string };

  if (rect.err) {
    check("ctx", false, rect.err);
  } else {
    const at = { x: rect.x!, y: rect.y!, button: "left" as const, clickCount: 1 };
    win.webContents.sendInputEvent({ type: "mouseDown", ...at });
    win.webContents.sendInputEvent({ type: "mouseUp", ...at });
    await wait(500);
    const after = String(
      await run(
        win,
        `navigator.clipboard.readText().then((t) => JSON.stringify({ 剪贴板: t, 菜单已关: !document.querySelector(".ctx") })).catch(() => '{"剪贴板":"(读不到)"}')`,
      ),
    );
    say("smoke-ctx-click", `在 (${rect.x!}, ${rect.y!}) 真点了一下 → ${after}`);
    check("ctx", !after.includes("__哨兵__"), `鼠标点「复制工作目录」之后剪贴板没变：${after}`);
  }
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

/** 挂上冒烟流程。`quit` 在最后一步被调用，**带退出码** —— 见 `check`。 */
export function attachSmoke(win: BrowserWindow, quit: (code: number) => void): void {
  const delay = Number(env("DELAY") ?? 1500);

  /**
   * `NOLOAD` / `BADLOAD`：验「页面根本没加载出来时，窗口还显示不显示」。
   *
   * **这两条不能挂在 `did-finish-load` 上** —— 页面加载不出来正是它们的前提，
   * 挂在那上面等于永远不跑，然后超时被杀掉，看起来像「没测到问题」。
   *
   * 它们守的是 `void win.loadFile(...)` 曾经的结局：加载失败被整个吞掉 →
   * `ready-to-show` 永不触发 → 窗口永远不显示，**而且一个字都不说**。
   */
  const loadMode = env("NOLOAD") === "1" ? "NOLOAD" : env("BADLOAD") === "1" ? "BADLOAD" : null;
  if (loadMode !== null) {
    void (async () => {
      // 比 15 秒的看门狗宽一点；NOLOAD 那条把看门狗调到了 2 秒
      await wait(loadMode === "NOLOAD" ? 6000 : 20_000);
      const vis = win.isVisible();
      say("smoke-load", JSON.stringify({ 模式: loadMode, 窗口显示了: vis }));
      check(
        "load",
        vis,
        `${loadMode}：页面没加载出来，窗口也没显示 —— 用户看到的就是「双击了图标什么都没发生」`,
      );
      if (failures.length > 0) for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
      else process.stdout.write("[smoke-result] 全部通过\n");
      quit(failures.length > 0 ? 1 : 0);
    })();
    return;
  }

  win.webContents.once("did-finish-load", () => {
    void (async () => {
      if (env("NEW") === "all") {
        await smokeNewAll(win);
        await checkAccounting(win, "new-all");
      } else if (env("NEW") === "1") {
        await smokeNew(win);
        await checkAccounting(win, "new");
      }
      if (env("FROM_HISTORY")) {
        await smokeFromHistory(win, env("FROM_HISTORY")!);
        await checkAccounting(win, "history");
      }
      // 主题要在截图**之前**换 —— 只在深色里好看的细节不算修好
      const shotPatch: Record<string, string> = {};
      if (env("THEME")) shotPatch["themeId"] = env("THEME")!;
      if (env("MODE")) shotPatch["mode"] = env("MODE")!;
      if (env("SHOT") && Object.keys(shotPatch).length) {
        await run(win, `window.agentory.setTheme(${JSON.stringify(shotPatch)})`);
        await wait(600);
      }
      if (env("SHOT")) await smokeShots(win, env("SHOT")!);
      if (env("FAVORITE")) {
        await smokeFavorite(win);
        await checkAccounting(win, "favorite");
      }
      if (env("START_MEMBER")) {
        await smokeStartMember(win);
        await checkAccounting(win, "start-member");
      }
      if (env("BROKEN") === "1") await smokeBroken(win);
      if (env("SUMMARY") === "1") await smokeSummary(win);
      if (env("VERSIONS") === "1") await smokeVersions(win);
      if (env("HARNESS") === "1") await smokeHarness(win);
      if (env("DIAG") === "1") await smokeDiag(win);
      if (env("CLEAN") === "1") await smokeClean(win, env("CLEAN_SHOTS") ?? null, check);
      if (env("DPAPI")) await smokeDpapi(win, env("DPAPI")!, check);
      if (env("KEYS") === "1") await smokeKeys(win);
      if (env("ZOOM")) await smokeZoom(win);
      if (env("UPDATE")) await smokeUpdate(win, env("UPDATE")!);
      if (env("SUMEXPAND") === "1") await smokeSumExpand(win);
      if (env("HISTPERF") === "1") await smokeHistPerf(win);
      if (env("BELL") === "1") await smokeBell(win);
      if (env("END") === "1") {
        await smokeEnd(win);
        await checkAccounting(win, "end");
      }

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
      // 改名避开上面那个 `check()` 断言函数 —— 同名会遮蔽，读的人会以为是同一个东西
      const { check: selfCheck, dump } = JSON.parse(r) as { check: unknown; dump?: string };
      say("smoke", JSON.stringify(selfCheck));

      /**
       * **渲染层到底启动了没有。**
       *
       * `main.ts` 是一整块顶层脚本，`$()` 找不到 id 就抛「界面缺少 #x」——
       * 任何一个 id 打错就是白屏。抛在顶层的话后面的自检根本不会被赋值，
       * 而在这条断言之前，那种情况只是打印 `[smoke] undefined`，没人会红。
       *
       * 这比在 happy-dom 里搭一个 40 个方法的 api 桩去 import main.ts 可靠得多：
       * 那种桩只要有一个默认值形状写错，测试就会绿着而界面是坏的。
       */
      const sc = selfCheck as { bridge?: boolean } | undefined;
      check("boot", sc !== undefined && sc !== null, "渲染层没有自检对象 —— 顶层脚本多半抛了");
      check("boot", sc?.bridge === true, "preload 桥没挂上");
      process.stdout.write(`[dump-begin]\n${dump ?? "(无)"}\n[dump-end]\n`);

      if (failures.length) {
        process.stdout.write(`[smoke-result] 失败 ${failures.length} 项\n`);
        for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
      } else {
        process.stdout.write("[smoke-result] 全部通过\n");
      }

      /**
       * `CLOSE=1`：**叉掉窗口，然后什么都不做。**
       *
       * 托盘常驻要验的那件事，只能从进程外面看：窗口没了之后，
       * 这个进程还活着吗？会话还在跑吗？所以这里只负责制造那个状态，
       * 判断交给 `scripts/verify-tray.cjs`（它拿着进程快照在外面等）。
       *
       * 注意**不调 `quit`** —— 调了就分不清「应用自己退的」和「叉窗口退的」。
       */
      if (env("CLOSE") === "1") {
        say("smoke-close", `叉窗口前：${livePids().length} 个 pty，pid=${livePids().join()}`);
        win.close();
        return;
      }

      quit(failures.length ? 1 : 0);
    })().catch((e: unknown) => {
      /**
       * **抛错必须退出，不能挂着。**
       *
       * 这里原本没有 catch：任何一个模式里的意外抛错都会让这个 IIFE 静默 reject，
       * `quit()` 永远不执行，应用就那么开着 —— 命令行看起来像卡死，
       * 没有输出、没有退出码。实测撞到了：`smokeBell` 在没有标签页时
       * `querySelector("#tabs .tab").click()` 抛 TypeError，冒烟挂了半小时。
       *
       * **挂起比失败糟得多**：失败会被人看见，挂起只会被人 Ctrl+C 掉然后忘掉。
       */
      process.stdout.write(`[smoke-result] 冒烟自己抛错了：${String(e)}\n`);
      quit(1);
    });
  });
}
