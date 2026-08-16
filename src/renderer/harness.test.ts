// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessMatrix, McpEntry, Scope } from "../main/harness/types";
import type { AgentoryApi } from "../preload/index";
import { setupHarness } from "./harness";

/**
 * Skills 与 MCP 面板的真 DOM 测试。
 *
 * ## 为什么是这个文件先上 happy-dom
 *
 * 渲染层四个文件里它的 import 链最干净（没有 xterm、没有 electron、没有 CSS），
 * `setupHarness(deps)` 已经是依赖注入的形状，而且只用到 `api` 的 3 个方法 ——
 * 桩件五行就够。
 *
 * ## 纪律：这里绝不断言布局
 *
 * happy-dom 不排版：`getBoundingClientRect()` 全返回 0，`offsetHeight` 恒为 0。
 * 断言尺寸/可见性/重叠只会得到假绿。那些继续靠截图。
 * 这里只断言 **DOM 结构、文本、属性、以及桩 api 的调用次数与参数**。
 *
 * ## DOM 用真的 index.html
 *
 * 手搭一份 8 个 id 的假 DOM 也能跑，但那样 id 改名时测试照样绿。
 * 用真文件，顺带就守住了 `$()` 与 html 之间的 id 漂移。
 */

const HTML = readFileSync(join(import.meta.dirname, "index.html"), "utf8");

const AGENTS = ["claude", "codex", "opencode", "pi", "grok"] as const;

/** 一个「什么都读到了、什么都没有」的空矩阵，各用例按需覆盖字段。 */
const emptyMatrix = (): HarnessMatrix => ({
  mcp: [],
  skills: [],
  sources: AGENTS.flatMap((agent) =>
    (["skills", "mcp"] as const).map((kind) => ({
      agent,
      kind,
      path: `C:/fake/${agent}/${kind}`,
      state: "ok" as const,
      count: 0,
      note: null,
    })),
  ),
  problems: [],
});

const mcpEntry = (over: Partial<McpEntry> = {}): McpEntry => ({
  name: "thing",
  target: { kind: "stdio", argv: ["node", "server.js"] },
  disabledInConfig: null,
  envNames: [],
  headerNames: [],
  inlineSecrets: [],
  source: "C:/fake/.mcp.json",
  ...over,
});

interface Stub {
  scan: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  uninstall: ReturnType<typeof vi.fn>;
}

/** 五行的桩 api —— 面板只碰这三个方法。 */
function mount(matrix: HarnessMatrix, over: Partial<Stub> = {}): Stub {
  const scan = over.scan ?? vi.fn().mockResolvedValue(matrix);
  const install = over.install ?? vi.fn().mockResolvedValue({ ok: true });
  const uninstall = over.uninstall ?? vi.fn().mockResolvedValue({ ok: true });
  setupHarness({
    api: { harnessScan: scan, harnessInstallSkill: install, harnessUninstallSkill: uninstall } as unknown as AgentoryApi,
    scopes: () => [{ cwd: "C:/proj", label: "proj" }],
    note: () => undefined,
  });
  return { scan, install, uninstall };
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const open = async (): Promise<void> => {
  $("btnHarness").click();
  // 面板的渲染挂在 harnessScan 的 .then 上 —— 让微任务跑完
  await new Promise((r) => setTimeout(r, 0));
};
const cells = (): HTMLElement[] => [...$("hxBody").querySelectorAll<HTMLElement>(".hx-box")];

beforeEach(() => {
  document.documentElement.innerHTML = HTML;
});

describe("skill 格子的装卸", () => {
  const oneSkill = (): HarnessMatrix => ({
    ...emptyMatrix(),
    skills: [{ name: "pdf", byAgent: { claude: { name: "pdf", path: "C:/fake/claude/skills/pdf" } } }],
  });

  it("点一个别人有、自己没有的格子 → 走安装，参数是来源路径与目标 agent", async () => {
    const s = mount(oneSkill());
    await open();
    const codexCell = cells().find((c) => c.dataset["agent"] === "codex")!;
    codexCell.click();
    expect(s.install).toHaveBeenCalledTimes(1);
    expect(s.install.mock.calls[0]).toEqual([
      "C:/fake/claude/skills/pdf",
      "codex",
      { kind: "global" } satisfies Scope,
      "pdf",
    ]);
    expect(s.uninstall).not.toHaveBeenCalled();
  });

  it("点一个自己已经有的格子 → 走卸载，参数是自己的路径", async () => {
    const s = mount(oneSkill());
    await open();
    const claudeCell = cells().find((c) => c.dataset["agent"] === "claude")!;
    claudeCell.click();
    expect(s.uninstall).toHaveBeenCalledTimes(1);
    expect(s.uninstall.mock.calls[0]?.[0]).toBe("C:/fake/claude/skills/pdf");
    expect(s.install).not.toHaveBeenCalled();
  });

  /**
   * **一次 rejection 让整张表永久点不动。**
   *
   * `busy = true` 在点击时设，`busy = false` 只在 `.then(done)` 里；而那两行
   * （`harness.ts:237-238`）**没有 `.catch`**。任何一次 IPC 意外 rejection 之后，
   * 所有格子点了都没反应，而且一个字都不说。
   *
   * 讽刺的是同一个文件往上 45 行就为这件事写过注释：
   * 「没有这个 catch，一次意外 rejection 就让面板永远停在『正在读…』」。
   * 同一个教训，第二处漏了。
   */
  it("装载 IPC reject 之后，格子还能再点（不会永久卡死）", async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error("目标目录只读")).mockResolvedValue({ ok: true });
    mount(oneSkill(), { install });
    await open();

    cells().find((c) => c.dataset["agent"] === "codex")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(install).toHaveBeenCalledTimes(1);

    // 第二次点击必须还能打到 api
    cells().find((c) => c.dataset["agent"] === "codex")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("装载 IPC reject 之后，界面要说出原因，不能装作没发生", async () => {
    mount(oneSkill(), { install: vi.fn().mockRejectedValue(new Error("目标目录只读")) });
    await open();
    cells().find((c) => c.dataset["agent"] === "codex")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect($("hxSummary").textContent).toContain("目标目录只读");
  });

  it("没人有的 skill 行不该出现（无从复制）—— 有人有才有可点的格子", async () => {
    mount(oneSkill());
    await open();
    // 五个 agent 五个格子，其中一个已装
    expect(cells()).toHaveLength(5);
    expect(cells().filter((c) => c.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });
});

describe("MCP 格子的五种状态各有各的记号", () => {
  const withMcp = (agent: (typeof AGENTS)[number], es: McpEntry[], srcState?: string): HarnessMatrix => {
    const m = emptyMatrix();
    m.mcp = [{ name: "srv", byAgent: { [agent]: es } }];
    if (srcState) {
      const s = m.sources.find((x) => x.agent === agent && x.kind === "mcp")!;
      s.state = srcState as never;
      s.note = "说明";
    }
    return m;
  };
  const cellOf = (agent: string): HTMLElement =>
    [...$("hxBody").querySelectorAll<HTMLElement>(".hx-row")]
      .filter((r) => !r.classList.contains("hx-head"))
      .at(-1)!
      .querySelectorAll<HTMLElement>(".hx-cell")[AGENTS.indexOf(agent as never)]!;

  it("不支持 → —（pi 没有 MCP）", async () => {
    const m = withMcp("claude", [mcpEntry()]);
    const src = m.sources.find((x) => x.agent === "pi" && x.kind === "mcp")!;
    src.state = "unsupported";
    src.note = "pi 不支持 MCP";
    mount(m);
    await open();
    expect(cellOf("pi").textContent).toBe("—");
  });

  it("读不出 → ?（绝不显示成 0 条）", async () => {
    mount(withMcp("claude", [mcpEntry()], "unreadable"));
    await open();
    expect(cellOf("claude").textContent).toBe("?");
  });

  it("没配 → ·", async () => {
    mount(withMcp("claude", [mcpEntry()]));
    await open();
    expect(cellOf("codex").textContent).toBe("·");
  });

  it("配了一处 → ●；配了多处 → ●●（不合并、不选胜者）", async () => {
    mount(withMcp("claude", [mcpEntry(), mcpEntry({ source: "C:/另一处" })]));
    await open();
    expect(cellOf("claude").textContent).toContain("●●");
    expect(cellOf("claude").querySelector("span")?.getAttribute("title")).toContain("2 处定义");
  });

  it("配置里写了 enabled = false → ○，且提示说清楚", async () => {
    mount(withMcp("claude", [mcpEntry({ disabledInConfig: true })]));
    await open();
    expect(cellOf("claude").textContent).toContain("○");
    expect(cellOf("claude").querySelector("span")?.getAttribute("title")).toContain("enabled = false");
  });

  /**
   * 明文凭证的角标是这个面板最有价值的一个功能，而它到今天零自动守卫 ——
   * 只能靠人盯截图。**只报字段路径，绝不报值**（`McpEntry` 类型上就装不下秘密）。
   */
  it("配置里存着明文凭证 → 角标 !，提示里是字段路径而不是值", async () => {
    mount(withMcp("claude", [mcpEntry({ inlineSecrets: ["env.API_KEY"] })]));
    await open();
    expect(cellOf("claude").querySelector(".hx-key")?.textContent).toBe("!");
    const tip = cellOf("claude").querySelector("span")?.getAttribute("title") ?? "";
    expect(tip).toContain("env.API_KEY");
  });

  it("需要环境变量时提示里列出变量名 —— 「为什么它在这台机器上不工作」的答案", async () => {
    mount(withMcp("claude", [mcpEntry({ envNames: ["BRAVE_API_KEY"] })]));
    await open();
    expect(cellOf("claude").querySelector("span")?.getAttribute("title")).toContain("BRAVE_API_KEY");
  });
});

describe("空态：「一个都没有」和「被筛掉了」是两回事", () => {
  it("确实一条都没有时不说「没有匹配的」", async () => {
    mount(emptyMatrix());
    await open();
    const t = $("hxBody").textContent ?? "";
    expect(t).toContain("一个 skill 都没有");
    expect(t).toContain("一个 MCP 服务器都没有配");
    expect(t).not.toContain("没有匹配");
  });

  it("有内容但被搜索词筛光了才说「没有匹配的」", async () => {
    const m = emptyMatrix();
    m.skills = [{ name: "pdf", byAgent: { claude: { name: "pdf", path: "C:/x/pdf" } } }];
    m.mcp = [{ name: "srv", byAgent: { claude: [mcpEntry()] } }];
    mount(m);
    await open();
    ($("hxSearch") as HTMLInputElement).value = "不可能匹配到的词";
    $("hxSearch").dispatchEvent(new Event("input"));
    const t = $("hxBody").textContent ?? "";
    expect(t).toContain("没有匹配的 skill");
    expect(t).toContain("没有匹配的 MCP");
  });

  it("切到项目作用域时 MCP 区说明原因，不是摆一张空表", async () => {
    mount(emptyMatrix());
    await open();
    const sel = $("hxScope") as HTMLSelectElement;
    sel.value = "C:/proj";
    sel.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect($("hxBody").textContent).toContain("项目级 MCP 只有 claude 和 grok 支持");
  });
});

describe("结构性前提", () => {
  /**
   * 两个 `position: sticky` 的表头同属一个滚动容器时会叠在一起（截图里糊成一团）。
   * 截图验的是最终像素，这条验的是**产生它的结构**：包裹层没了一定会叠。
   */
  it("每个区块一个 .hx-sec 包裹层", async () => {
    const m = emptyMatrix();
    m.skills = [{ name: "pdf", byAgent: { claude: { name: "pdf", path: "C:/x/pdf" } } }];
    m.mcp = [{ name: "srv", byAgent: { claude: [mcpEntry()] } }];
    mount(m);
    await open();
    expect($("hxBody").querySelectorAll(".hx-sec")).toHaveLength(2);
    for (const sec of $("hxBody").querySelectorAll(".hx-sec")) {
      expect(sec.querySelectorAll(".hx-h")).toHaveLength(1);
    }
  });

  it("扫描 reject 时面板说读不出来，不会永远停在「正在读…」", async () => {
    mount(emptyMatrix(), { scan: vi.fn().mockRejectedValue(new Error("扫描炸了")) });
    await open();
    expect($("hxBody").textContent).toContain("读不出来");
    expect($("hxBody").textContent).not.toContain("正在读");
  });

  it("默认作用域是全局，而当前项目排在下拉第一项之后", async () => {
    mount(emptyMatrix());
    await open();
    const sel = $("hxScope") as HTMLSelectElement;
    expect(sel.value).toBe("");
    expect(sel.options[0]?.value).toBe("");
    expect(sel.options[1]?.value).toBe("C:/proj");
  });
});
