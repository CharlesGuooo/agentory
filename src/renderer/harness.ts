import type { HarnessMatrix, Scope } from "../main/harness/types";
import type { AgentId } from "../main/sessions/types";
import type { AgentoryApi } from "../preload/index";
import { $, closeHarness, esc, openHarness } from "./shell";

/**
 * Skills 与 MCP 面板。
 *
 * 单独一个模块而不是塞进 `main.ts`（已经 990 行）—— 它有自己的状态、
 * 自己的渲染函数、自己的事件，和别的东西没有共享的可变状态。
 *
 * ## 一句话定位：矩阵的格子就是开关
 *
 * 不另做一套「plugin 管理界面」。skill 格子可点（装 = 复制目录、卸 = 丢回收站），
 * MCP 格子只读（改配置文件的风险是另一个数量级）。读和写是同一张表、同一个数据层。
 */

const AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

export interface HarnessDeps {
  api: AgentoryApi;
  /**
   * 作用域候选。**第一项是种子**（当前 tab 的目录），其余是工作集与收藏里的目录。
   * 由调用方提供，因为那些状态住在 `main.ts`。
   */
  scopes: () => { cwd: string; label: string }[];
  /** 记一笔给冒烟自检看。 */
  note: (v: unknown) => void;
}

export function setupHarness(deps: HarnessDeps): void {
  const { api } = deps;
  let matrix: HarnessMatrix | null = null;
  let scope: Scope = { kind: "global" };
  let busy = false;

  const sourceOf = (agent: AgentId, kind: "mcp" | "skills"): HarnessMatrix["sources"][number] | undefined =>
    matrix?.sources.find((s) => s.agent === agent && s.kind === kind);

  function renderScopeSelect(): void {
    const sel = $("hxScope") as HTMLSelectElement;
    sel.innerHTML =
      '<option value="">全局</option>' +
      deps
        .scopes()
        .map((c) => `<option value="${esc(c.cwd)}" title="${esc(c.cwd)}">${esc(c.label)}</option>`)
        .join("");
    sel.value = scope.kind === "global" ? "" : scope.cwd;
  }

  /**
   * MCP 格子。**五种状态，每种只有一个记号** ——
   * 全渲染成空白就是撒谎：「不支持」「读不出」「没配」是三件完全不同的事。
   */
  function mcpCell(row: HarnessMatrix["mcp"][number], agent: AgentId): string {
    const src = sourceOf(agent, "mcp");
    if (src?.state === "unsupported") {
      return `<span class="hx-na" title="${esc(src.note ?? "这个 agent 不支持 MCP")}">—</span>`;
    }
    if (src?.state === "unreadable") return '<span class="hx-unk" title="配置读不出来">?</span>';

    const es = row.byAgent[agent] ?? [];
    if (es.length === 0) return '<span class="hx-no">·</span>';

    const off = es.every((e) => e.disabledInConfig === true);
    const secret = es.some((e) => e.inlineSecrets.length > 0);
    const needs = [...new Set(es.flatMap((e) => [...e.envNames, ...e.headerNames]))];
    const tip = [
      es.length > 1 ? `${es.length} 处定义 —— 我们不替你判断哪个生效` : "",
      off ? "配置里写着 enabled = false" : "",
      secret ? `配置里存着明文凭证：${es.flatMap((e) => e.inlineSecrets).join("、")}` : "",
      // 「为什么这个 MCP 在这台机器上不工作」的答案通常就是缺了某个环境变量
      needs.length > 0 ? `需要环境变量：${needs.join("、")}` : "",
      ...es.map((e) => e.source),
    ]
      .filter(Boolean)
      .join("\n");
    const mark = off ? "○" : es.length > 1 ? "●●" : "●";
    return `<span class="hx-on${off ? " off" : ""}" title="${esc(tip)}">${mark}${
      secret ? '<i class="hx-key">!</i>' : ""
    }</span>`;
  }

  /** skill 格子 —— 可点。装的来源是任意一个已经有它的 agent。 */
  function skillCell(row: HarnessMatrix["skills"][number], agent: AgentId): string {
    const src = sourceOf(agent, "skills");
    if (src?.state === "unreadable") return '<span class="hx-unk" title="目录读不出来">?</span>';

    const hit = row.byAgent[agent];
    const from = AGENTS.map((a) => row.byAgent[a]).find((v) => v !== undefined)?.path ?? "";
    const tip = hit ? `已装：${hit.path}\n点一下丢进系统回收站` : `点一下从 ${from} 复制过来`;
    return `<button class="hx-box${hit ? " on" : ""}" type="button" role="checkbox"
      aria-checked="${hit ? "true" : "false"}" title="${esc(tip)}"
      data-skill="${esc(row.name)}" data-agent="${agent}"
      data-path="${esc(hit?.path ?? "")}" data-from="${esc(from)}">${hit ? "✓" : ""}</button>`;
  }

  const headRow = (first: string): string =>
    `<div class="hx-row hx-head"><span class="hx-name">${first}</span>` +
    AGENTS.map((a) => `<span class="hx-cell">${a}</span>`).join("") +
    "</div>";

  function render(): void {
    if (!matrix) return;
    const q = ($("hxSearch") as HTMLInputElement).value.trim().toLowerCase();
    const hit = (n: string): boolean => q === "" || n.toLowerCase().includes(q);

    // 状态条：先于格子存在。没有它，空格子会被读成「没配」而不是「读不到」
    $("hxSources").innerHTML = matrix.sources
      .map((s) => {
        const cls = s.state === "ok" ? "ok" : s.state === "unreadable" ? "bad" : "dim";
        const n =
          s.state === "unsupported"
            ? "不支持"
            : s.state === "unreadable"
              ? "读不出"
              : s.state === "missing"
                ? "没有"
                : String(s.count);
        const what = s.kind === "mcp" ? "MCP" : "skills";
        return `<span class="hx-src ${cls}" title="${esc(s.note ?? s.path)}">${s.agent} ${what} <b>${n}</b></span>`;
      })
      .join("");

    const skills = matrix.skills.filter((r) => hit(r.name));
    const mcp = matrix.mcp.filter((r) => hit(r.name));
    const rowsOf = (
      list: { name: string }[],
      cell: (row: never, a: AgentId) => string,
    ): string =>
      list
        .map(
          (r) =>
            `<div class="hx-row"><span class="hx-name" title="${esc(r.name)}">${esc(r.name)}</span>` +
            AGENTS.map((a) => `<span class="hx-cell">${cell(r as never, a)}</span>`).join("") +
            "</div>",
        )
        .join("");

    /**
     * **每个区块自己一个 `.hx-sec` 包裹层。**
     * 两个 `position: sticky` 的表头如果同属一个滚动容器，它们都钉在 `top: 0`，
     * 第二个上来时第一个还在那儿 —— 截图里就是糊成一团的两行。
     * 各自有包裹层之后，表头会随自己那一段一起滚走。
     */
    const section = (title: string, sub: string, body: string): string =>
      `<section class="hx-sec"><h3 class="hx-h">${title}<small>${sub}</small></h3>${body}</section>`;

    $("hxBody").innerHTML =
      section(
        "Skills",
        "点格子装 / 卸。卸载是丢进系统回收站，可以自己恢复",
        skills.length > 0
          ? headRow("skill") + rowsOf(skills, skillCell as never)
          : '<p class="desc">没有匹配的 skill</p>',
      ) +
      section(
        "MCP",
        "只读 —— 改配置文件要处理竞态、格式保留和四套字段互译，这一刀不做",
        scope.kind === "project"
          ? '<p class="desc">项目级 MCP 只有 claude 和 grok 支持，这一刀不读</p>'
          : mcp.length > 0
            ? headRow("服务器") + rowsOf(mcp, mcpCell as never)
            : '<p class="desc">没有匹配的 MCP</p>',
      );

    $("hxSummary").textContent =
      `${matrix.skills.length} 个 skill · ${matrix.mcp.length} 个 MCP` +
      (matrix.problems.length > 0 ? ` · ${matrix.problems.length} 个问题` : "");
    deps.note({
      skills: matrix.skills.length,
      mcp: matrix.mcp.length,
      问题: matrix.problems.length,
    });
  }

  function load(): void {
    $("hxBody").innerHTML = '<p class="desc">正在读…</p>';
    void api.harnessScan(scope).then((m) => {
      matrix = m;
      render();
    });
  }

  $("btnHarness").addEventListener("click", () => {
    openHarness();
    /**
     * **默认全局，不是默认当前项目。**
     *
     * 原本是拿当前 tab 的目录当种子，冒烟立刻暴露了问题：那个项目没有项目级 skill，
     * 面板一打开就是一张空表（`0 个 skill · 0 个 MCP`）。大多数项目都没有项目级 harness，
     * 所以那个默认值几乎总是错的。
     *
     * 折中：全局兜底，而**当前 tab 的目录排在下拉第一项** —— 一次点击就能切过去，
     * 而且切换是你自己做的，面板不会在你切 tab 时悄悄变。
     */
    scope = { kind: "global" };
    renderScopeSelect();
    load();
  });
  $("hxClose").addEventListener("click", closeHarness);
  $("hxScrim").addEventListener("click", (e) => {
    if (e.target === $("hxScrim")) closeHarness();
  });
  $("hxSearch").addEventListener("input", render);
  $("hxScope").addEventListener("change", () => {
    const v = ($("hxScope") as HTMLSelectElement).value;
    scope = v === "" ? { kind: "global" } : { kind: "project", cwd: v };
    load();
  });

  $("hxBody").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest(".hx-box") as HTMLButtonElement | null;
    if (!b || busy) return;
    const { skill, agent, path, from } = b.dataset as Record<string, string>;
    if (!skill || !agent) return;
    if (!path && !from) return; // 没人有它，无从复制

    busy = true;
    b.disabled = true;
    const done = (r: { ok: boolean; error?: string }): void => {
      busy = false;
      if (!r.ok) $("hxSummary").textContent = r.error ?? "操作失败";
      load();
    };
    if (path) void api.harnessUninstallSkill(path, scope).then(done);
    else void api.harnessInstallSkill(from!, agent as AgentId, scope, skill).then(done);
  });
}
