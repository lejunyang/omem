import { describe, expect, it } from "vitest";
import { plainLine, unblock } from "../web/src/lib/plain.ts";

describe("short texts outside a page (web/src/lib/plain.ts)", () => {
  it("drops block marks but keeps the words", () => {
    expect(unblock("# 标题\n\n> 引用的一句\n- 第一条\n- 第二条")).toBe("标题\n引用的一句\n· 第一条\n· 第二条");
  });

  it("gives a row title from a task written as Markdown", () => {
    expect(plainLine("# 规则「周报巡检」触发\n本人的规则：每周五巡检一次。")).toBe("规则「周报巡检」触发");
    expect(plainLine("**先核对部署**，再打开回归关卡。`npm test`")).toBe("先核对部署，再打开回归关卡。npm test");
  });

  it("removes references and link targets, keeps link text", () => {
    expect(plainLine("见 [《差旅报销制度》](src:s0abcdefgh12#L3-L9) 第二节。src:s0abcdefgh12#L1")).toBe("见 《差旅报销制度》 第二节。");
    expect(plainLine("结论在 [[cases/refund|退款案例]]（mem:m0abcdefgh）")).toBe("结论在 退款案例");
  });

  it("cuts a long line with an ellipsis and survives empty input", () => {
    expect(plainLine("一".repeat(200), 20)).toHaveLength(20);
    expect(plainLine("一".repeat(200), 20).endsWith("…")).toBe(true);
    expect(plainLine("")).toBe("");
    expect(plainLine("\n\n- 只有一条")).toBe("只有一条");
  });

  it("reads a one-word heading together with the line under it", () => {
    expect(plainLine("## 今天\n\n- 退款改造等你核对后推送\n- 发票抬头在观察")).toBe("今天：退款改造等你核对后推送");
    expect(plainLine("要点：\n先核对部署")).toBe("要点：先核对部署");
  });
});
