import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanAllAgents } from "./all";
import { pickInformative, previewOf, PREVIEW_MAX } from "./preview";
import type { AgentId } from "./types";

/**
 * 「挑哪一条」是纯逻辑，用合成输入测透；
 * 「从文件里读出来」是 I/O，对本机真实会话跑 —— 造 fixture 只能证明我理解的格式，
 * 证明不了 agent 真的这么写。
 */

describe("挑出有信息量的那条", () => {
  it("第一条就够长就用第一条", () => {
    expect(pickInformative(["帮我评估单卡 RTX PRO 6000 跑 DeepSeek V4 的可行性"])).toBe(
      "帮我评估单卡 RTX PRO 6000 跑 DeepSeek V4 的可行性",
    );
  });

  /** D-F2 的核心。实测失败样本全是这一类：真内容在第二条。 */
  it("第一条太短就取下一条", () => {
    expect(pickInformative(["看这里的文件，理解我要做什么", "把 README 里的装机清单换成单卡方案"])).toBe(
      "把 README 里的装机清单换成单卡方案",
    );
  });

  it("斜杠命令跳过 —— pi 的 /help 实测就是这种", () => {
    expect(pickInformative(["/help", "/init", "升级一下这个电脑里的 opencode 到最新版本"])).toBe(
      "升级一下这个电脑里的 opencode 到最新版本",
    );
  });

  it("全都没信息时返回 null，不返回空串", () => {
    // 空串会让界面显示成空白，而空白看起来像"还在加载"
    expect(pickInformative(["pull一下最新的", "继续", "  ", ""])).toBeNull();
    expect(pickInformative([])).toBeNull();
  });

  it("压缩连续空白后再判长度", () => {
    // 一堆换行撑出来的"长度"不是信息量
    expect(pickInformative(["短\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n了"])).toBeNull();
  });

  it("截断到上限，且不返回带首尾空白的结果", () => {
    const long = `请你${"很".repeat(200)}长`;
    const got = pickInformative([long]);
    expect(got).not.toBeNull();
    // 输入比上限长，所以结果**就该正好等于上限** —— `<=` 那种写法，
    // 哪天截过头返回 5 个字它也照样绿
    expect(got!.length).toBe(PREVIEW_MAX);
    expect(got).toBe(got!.trim());
  });

  /**
   * 这条钉的是本刀改掉的那件事。
   *
   * 上限原来是 46，注释写的是「窄侧栏折两行大约就是这个量」—— 显示约束漏进了数据层。
   * 用户右键「复制摘要」复制出来是一句半截话，而**全文根本不存在**。
   * 下面这句 74 字的真实开头，在旧上限下会被切在「还是说他们已经」。
   */
  it("一句正常长度的开头不该被切 —— 旧上限 46 会把它切成半句", () => {
    const real =
      "看一下这里的.cursor里的harnes，是否可以完整移植给.cluade？还是说他们已经有一套等价的机制，不需要再搬一遍";
    expect(real.length).toBeGreaterThan(46);
    expect(pickInformative([real])).toBe(real);
  });

  it("分隔线之类的符号串不算信息 —— 实测有一条会话开头就是它", () => {
    expect(pickInformative(["=".repeat(46), "把这份简历改写成投行岗位的版本，重排项目顺序"])).toBe(
      "把这份简历改写成投行岗位的版本，重排项目顺序",
    );
  });

  /**
   * 关键的一条：**规则是结构性的，不是白名单**。
   * 实测连着撞见三个 §2.6 表上没有的包装标签（grok 的 `<user_query>`、
   * codex 的 `<recommended_plugins>`、以及表里有的那几个）。所以这里故意用一个
   * **编造的**标签名 —— 它能被挡住，才说明下一个未知包装也会被挡住。
   */
  it("没见过的包装标签也挡得住", () => {
    expect(
      pickInformative([
        `<never_seen_before>\n一段谁也没预料到的系统提示\n</never_seen_before>`,
        "把装机清单里的双卡方案换成单卡，并重算总价",
      ]),
    ).toBe("把装机清单里的双卡方案换成单卡，并重算总价");
  });

  it("剥开 <user_query> 取里面的话，而不是把它当注入丢掉", () => {
    expect(pickInformative([`<user_query>\n帮我查一下 2026 年世界杯谁拿了冠军\n</user_query>`])).toBe(
      "帮我查一下 2026 年世界杯谁拿了冠军",
    );
  });

  /**
   * 已知取舍：长度只是信息量的**代理指标**。
   * 20 字这条线来自实测 —— 本机失败样本全在线下（`请你看这里的文件，了解我想做什么`
   * `pull一下最新的`）。代价是会误杀真正有信息的短句。
   * 不为这个再加一层启发式：真正的解法是摘要，不是更聪明的阈值。
   */
  it("短句一律跳过，包括有信息的那种 —— 这是已知代价", () => {
    expect(pickInformative(["把简历改成投行版"])).toBeNull();
  });
});

/** §2.6 那张表里列的全部注入形态。取到的预览里一个都不该出现。 */
const INJECTION = [
  "<command-",
  "<local-command-",
  "<system-reminder",
  "Caveat:",
  "# AGENTS.md",
  "<user_info>",
  // 表里原本没有这一条，是本变更实测发现的：grok 把用户真话包在 <user_query> 里
  "<user_query>",
  // 同样是实测撞见的：codex 以「用户消息」身份发插件推荐
  "<recommended_plugins>",
];

const AGENTS: AgentId[] = ["claude", "codex", "opencode", "pi", "grok"];

describe("真机预览提取", () => {
  const all = scanAllAgents().sessions;

  for (const agent of AGENTS) {
    it(
      `${agent}：至少一条能取到预览，且不含注入`,
      (ctx) => {
        const mine = all.filter((s) => s.agent === agent);
        if (mine.length === 0) return void ctx.skip();

        const hits = mine
          .map((s) => ({ s, p: previewOf(s) }))
          .filter((x) => x.p.text !== null);

        expect(hits.length).toBeGreaterThan(0);
        for (const { p } of hits) {
          for (const mark of INJECTION) expect(p.text).not.toContain(mark);
          // 比逐个列举更能抓漏网的：包装标签一律以 < 开头。
          // grok 的 <user_query> 就是靠这条才暴露出来的 —— 白名单永远列不全。
          expect(p.text!.startsWith("<")).toBe(false);
          expect(p.text!.length).toBeLessThanOrEqual(PREVIEW_MAX);
        }
        console.log(`\n  ${agent}（${hits.length}/${mine.length} 条取到）：${hits[0]!.p.text}\n`);
      },
      120_000,
    );
  }

  /**
   * 「绝不整文件读」要可断言，不能靠计时去猜 —— 本机存在 195 MB 的单会话文件。
   * opencode 走 SQLite（带 LIMIT），没有"读了多少字节"的概念，跳过。
   */
  it(
    "大文件只读头部",
    (ctx) => {
      const big = all
        .filter((s) => s.agent !== "opencode" && s.agent !== "grok")
        .map((s) => ({ s, size: statSync(s.source).size }))
        .filter((x) => x.size > 5 * 1024 * 1024)
        .sort((a, b) => b.size - a.size)[0];
      if (!big) return void ctx.skip();

      const { bytesRead } = previewOf(big.s);
      console.log(`\n  ${(big.size / 1048576).toFixed(1)} MB 的文件只读了 ${bytesRead} 字节\n`);
      expect(bytesRead).toBeLessThan(big.size / 10);
    },
    120_000,
  );
});
