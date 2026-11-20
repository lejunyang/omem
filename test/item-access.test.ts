import { upsertSource } from "../src/sources/store.ts";
import { setVisibility } from "../src/auth/visibility.ts";
import { run } from "../src/core/db.ts";
import { expect, it } from "vitest";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser, removeMember } from "../src/core/users.ts";
import { upsertItem } from "../src/items/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

it("按事项归属和当前的空间授权列出、读取和修改事项", async () => {
  const app = testApp();
  createSpace(app, { id: "team", name: "共享项目" });
  createSpace(app, { id: "other", name: "其他项目" });
  for (const id of ["a", "b"]) {
    createUser(app, { id, name: id });
    addMember(app, "team", id, "editor");
  }
  const headers = { authorization: `Bearer ${createApiToken(app, "a", "test")}` };
  const server = await startServer(app, { port: 0, quiet: true });
  const create = (space?: string) => server.inject({ method: "POST", url: "/api/items", headers, payload: { title: "成员事项", space } });
  const list = async (query = "") => (await server.inject({ url: "/api/items" + query, headers })).json().map((i: { id: string }) => i.id);
  try {
    const mine = (await create("team")).json();
    expect(mine).toMatchObject({ userId: "a", spaceId: "team" });
    const personal = (await create()).json();
    expect(personal).toMatchObject({ userId: "a", spaceId: "personal-a" });
    for (const userId of ["owner", "b"]) {
      const other = upsertItem(app, undefined, { title: "其他事项", userId, spaceId: "team" });
      const url = "/api/items/" + other.id;
      expect(await list()).not.toContain(other.id);
      for (const path of [url, url + "/flow", url + "/objects", "/api/metrics?item=" + other.id])
        expect((await server.inject({ url: path, headers })).statusCode).toBe(404);
      expect((await server.inject({ method: "PATCH", url, payload: { title: "改名" }, headers })).statusCode).toBe(403);
      expect((await server.inject({ url })).statusCode).toBe(200);
    }
    const candidate = upsertItem(app, undefined, { title: "候选", spaceId: "team", userId: "b", status: "candidate" });
    for (const suffix of ["keep", "candidate"]) {
      expect((await server.inject({ method: "POST", url: `/api/items/${candidate.id}/${suffix}`, payload: { keep: true }, headers })).statusCode).toBe(403);
    }
    const line = upsertItem(app, undefined, { kind: "line", title: "项目线", userId: "a", spaceId: "team" });
    const url = "/api/items/" + personal.id;
    expect((await server.inject({ method: "PATCH", url, payload: { parent: line.id }, headers })).statusCode).toBe(200);
    const chat = upsertSource(app, { kind: "chat", uri: "demo:chat", title: "受限讨论", text: "讨论摘要", spaceId: "team" });
    const work = upsertSource(app, { kind: "work", uri: "work/记录", title: "工作记录", text: "内容", spaceId: "team", meta: { links: { item: personal.id } } });
    run(app.db, "insert into item_materials(item_id,kind,ref,label,added_by,created_at) values(?,'source',?,?,'user','2026-11-01')", personal.id, chat.id, "讨论");
    for (const src of [chat, work]) setVisibility(app, src.id, "restricted");
    const detail = (await server.inject({ url, headers })).json();
    expect(detail.files).toEqual([]);
    expect(detail.materials).toEqual([]);
    run(app.db, "insert into item_materials(item_id,kind,ref,label,added_by,created_at) values(?,'source','missing','旧材料','user','2026-11-01')", personal.id);
    expect((await server.inject({ url, headers })).json().materials).toEqual([]);
    expect((await server.inject({ url })).json().materials).toContainEqual(expect.objectContaining({ ref: "missing", missing: true }));
    expect(detail.places).toEqual([]);
    addMember(app, "team", "a", "reader");
    expect((await server.inject({ method: "PATCH", url, payload: { parent: null, title: "改名" }, headers })).statusCode).toBe(403);
    expect((await server.inject({ url, headers })).json().item).toMatchObject({ parentId: line.id, title: personal.title });
    expect((await create("team")).statusCode).toBe(403);
    expect((await server.inject({ url: "/api/items/" + mine.id, headers })).statusCode).toBe(200);
    removeMember(app, "team", "a");
    expect(await list("?space=team")).toEqual([]);
    expect(await list()).toEqual([personal.id]);
    expect((await server.inject({ url: "/api/items/" + mine.id, headers })).statusCode).toBe(404);
    for (const space of ["other", "personal-b"]) expect((await create(space)).statusCode).toBe(403);
    expect((await server.inject({ method: "PATCH", url: "/api/items/" + mine.id, payload: { title: "本人修改" } })).statusCode).toBe(200);
  } finally { await server.close(); app.db.close(); }
});
