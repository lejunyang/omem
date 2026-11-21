import { expect, it, vi } from "vitest";
import { githubReview } from "../plugins/github/server.ts";
import type { PluginConnection, WriteContext } from "../src/plugins/types.ts";

const head = "a".repeat(40);
const req = { findingId: 7, objectKey:"sample/project#3", anchor:{ head, path:"index.ts", startLine:2, line:4, side:"RIGHT" as const }, body:"修复边界" };
function fake(fetch: PluginConnection["fetch"]): WriteContext {
  return { userId:"owner",spaceId:"project",signal:AbortSignal.timeout(15000),idempotencyKey:"unique",
    connection: async () => ({ account:"sample",scopes:[],base:null,fetch }) };
}
const pr = (sha: string, body?: string) => Response.json({ data:{ repository:{ pullRequest:{ headRefOid:sha, reviewThreads:{ pageInfo:{ hasNextPage:false },
  nodes:body ? [{ id:"thread",comments:{ nodes:[{ body,viewerDidAuthor:true,url:"https://example.org/comment" }] } }] : [] } } } } });

it("绑定提交与多行位置，同一确认再次执行时从平台取回原讨论", async () => {
  let body: string | undefined;
  const fetch = vi.fn<PluginConnection["fetch"]>(async (path, init) => {
    if (path === "/graphql") return pr(head,body);
    expect(path).toBe("/repos/sample/project/pulls/3/comments");
    expect(body).toBeUndefined();
    const data = JSON.parse(String(init?.body));
    expect(data).toMatchObject({ commit_id:head,path:"index.ts",start_line:2,line:4,side:"RIGHT",start_side:"RIGHT" });
    body = data.body;
    return Response.json({ id:33 });
  });
  const ctx = fake(fetch);
  const ref = await githubReview.publish(ctx,req);
  expect(ref.id).toBe("thread");
  expect(await githubReview.publish(ctx,req)).toEqual(ref);
  expect(fetch.mock.calls.filter(([path]) => path !== "/graphql")).toHaveLength(1);
});

it("头提交变化和行不在 diff 内都返回锚点错误，权限失败可以重试", async () => {
  const changed = vi.fn(async () => pr("b".repeat(40)));
  await expect(githubReview.publish(fake(changed),req)).rejects.toMatchObject({ code:"REVIEW_ANCHOR_OUTDATED" });
  expect(changed).toHaveBeenCalledTimes(1);
  const invalid = fake(async path => path === "/graphql" ? pr(head) : new Response("Line must be part of the diff",{status:422}));
  await expect(githubReview.publish(invalid,req)).rejects.toMatchObject({code:"REVIEW_ANCHOR_OUTDATED"});
  const denied = fake(async path => path === "/graphql" ? pr(head) : new Response("",{status:403}));
  await expect(githubReview.publish(denied,req)).rejects.toThrow("403");
});

it("读取最近的他人回复并用讨论编号结束",async () => {
  const ref = { id:"thread",url:"https://example.org/comment" };
  const ctx = fake(async (path,init) => {
    expect(path).toBe("/graphql");
    const {query,variables} = JSON.parse(String(init?.body));
    expect(variables.id).toBe(ref.id);
    if (query.includes("mutation")) return Response.json({data:{resolveReviewThread:{thread:{isResolved:true}}}});
    return Response.json({data:{node:{isResolved:false,isOutdated:false,comments:{pageInfo:{hasPreviousPage:false},nodes:[
      {viewerDidAuthor:false,author:{login:"sample"},bodyText:"答".repeat(2000),createdAt:"2026-10-01T00:00:00Z",url:"https://example.org/reply"},
      {viewerDidAuthor:true,bodyText:"自己的回复"},
    ]}}}});
  });
  const t = await githubReview.readThread(ctx,ref);
  expect(t.state).toBe("replied");
  expect(t.reply?.summary).toHaveLength(1000);
  expect(await githubReview.resolve!(ctx,ref)).toEqual({state:"resolved"});
});
