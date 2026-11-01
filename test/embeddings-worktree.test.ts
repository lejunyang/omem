import { expect, it } from "vitest";
import { one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { embedPending, setEmbedderForTests } from "../src/search/embeddings.ts";
import { upsertSource } from "../src/sources/store.ts";
import { fakeEmbedder, testApp } from "./helpers.ts";

it("leaves the chunks of a worktree index unembedded: they are searched by text while the review lasts", async () => {
  const app = testApp();
  app.config.embeddings.provider = "local";
  setEmbedderForTests(fakeEmbedder());
  try {
    createSpace(app, { id: "wt-r1-shop-api", name: "订单服务 · 分支 feature/refund", kind: "repo" });
    upsertSource(app, { spaceId: "personal", kind: "note", uri: "note", title: "退款", text: "退款只按未发货的行计算。" });
    upsertSource(app, { spaceId: "wt-r1-shop-api", kind: "code", uri: "refund.ts", title: "refund.ts", text: "export const refund = (lines) => lines.filter((l) => !l.shipped);\n" });
    while (await embedPending(app)) {}
    const left = (space: string) => one<{ n: number }>(app.db, "select count(*) n from chunks where embedding is null and space_id = ?", space)!.n;
    expect(left("personal")).toBe(0);
    expect(left("wt-r1-shop-api")).toBeGreaterThan(0);
  } finally {
    setEmbedderForTests(null);
    app.db.close();
  }
});
