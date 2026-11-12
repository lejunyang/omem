import { expect, it } from "vitest";
import { atAsker } from "../src/channels/mention-reply.ts";

it("@s the asker once: the handler's own “@名字” becomes the real mention, otherwise one goes in front", () => {
  expect(atAsker("@小王 这个口径对上了", "小王", "ou_w")).toBe("<at id=ou_w></at> 这个口径对上了");
  expect(atAsker("对上了，辛苦 @小王 带一下", "小王", "ou_w")).toBe("对上了，辛苦 <at id=ou_w></at> 带一下");
  expect(atAsker("这个口径对上了", "小王", "ou_w")).toBe("<at id=ou_w></at> 这个口径对上了");
  expect(atAsker("@小王 好", "小王", null)).toBe("@小王 好");
});
