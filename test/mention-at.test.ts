import { expect, it } from "vitest";
import { atAsker } from "../src/channels/mention-reply.ts";

it("@s the asker once: the handler's own “@名字” becomes the real mention, otherwise one goes in front", () => {
  expect(atAsker("@小王 这个口径对上了", "小王", "ou_w")).toBe("<at id=ou_w></at> 这个口径对上了");
  expect(atAsker("对上了，辛苦 @小王 带一下", "小王", "ou_w")).toBe("对上了，辛苦 <at id=ou_w></at> 带一下");
  expect(atAsker("这个口径对上了", "小王", "ou_w")).toBe("<at id=ou_w></at> 这个口径对上了");
  expect(atAsker("@小王 好", "小王", null)).toBe("@小王 好");
});

it("turns every other @名字 into a real mention when the person is in the chat, and leaves the rest as written", async () => {
  const { atOthers, atAsker } = await import("../src/channels/mention-reply.ts");
  const ids: Record<string, string> = { 小李: "ou_li", 一帆: "ou_yf" };
  const known = (n: string) => n in ids;
  const resolve = async (n: string) => ids[n] ?? null;
  const text = "@小王 查过了。@一帆 确认下今天按 30% 还是 50%，@小李确认下管理员时间；@路人甲 不在群里";
  const out = atAsker(await atOthers(text, "小王", known, resolve), "小王", "ou_w");
  expect(out).toBe("<at id=ou_w></at> 查过了。<at id=ou_yf></at> 确认下今天按 30% 还是 50%，<at id=ou_li></at>确认下管理员时间；@路人甲 不在群里");
});
