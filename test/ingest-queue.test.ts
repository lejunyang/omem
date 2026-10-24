import { afterEach, describe, expect, it } from "vitest";
import { scheduleIngest } from "../src/agents/jobs.ts";
import { cancelRun, getRun, listRuns } from "../src/agents/runs.ts";
import { run, one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
const setup = () => { const app = testApp(); apps.push(app); return app; };
afterEach(() => apps.splice(0).forEach(app => app.db.close()));

describe("ingest batching", () => {
  it("merges duplicate sources and preserves the earliest appended line without extending the wait", () => {
    const app = setup();
    const input = { spaceId: "personal", kind: "chat" as const, uri: "chat:a", title: "项目 A" };
    upsertSource(app, { ...input, text: "已有记录" });
    const a = appendToSource(app, { ...input, lines: ["第一条新记录"] });
    const first = scheduleIngest(app, "personal", [a.id], "新增聊天")!;
    const due = one<{ not_before: string }>(app.db, "select not_before from runs where id=?", first.id)!.not_before;
    appendToSource(app, { ...input, lines: ["第二条新记录"] });
    const second = scheduleIngest(app, "personal", [a.id, a.id], "新增聊天")!;
    expect(second.id).toBe(first.id);
    expect(second.input.sourceIds).toEqual([a.id]);
    expect(second.input.sourceStarts).toEqual({ [a.id]: 2 });
    expect(one<{ not_before: string }>(app.db, "select not_before from runs where id=?", first.id)!.not_before).toBe(due);
  });

  it("bounds batches, isolates spaces and instructions, and leaves running/cancelled inputs intact", () => {
    const app = setup();
    createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    const ids = Array.from({ length: 85 }, (_, i) => upsertSource(app, { spaceId: "personal", kind: "note", uri: `note:${i}`, title: "材料", text: `内容 ${i}` }).id);
    for (const id of ids) scheduleIngest(app, "personal", [id], "历史材料");
    const batches = listRuns(app, { kind: "ingest" });
    expect(batches.map(r => (r.input.sourceIds as string[]).length).sort((a, b) => a - b)).toEqual([5, 40, 40]);
    expect(new Set(batches.flatMap(r => r.input.sourceIds as string[])).size).toBe(85);
    expect(new Set(batches.map(r => r.lane))).toEqual(new Set(["ingest:personal"]));
    const old = scheduleIngest(app, "personal", [ids[0]], "历史材料")!;
    run(app.db, "update runs set status='running' where id=?", old.id);
    const next = scheduleIngest(app, "personal", [ids[0]], "历史材料")!;
    expect(next.id).not.toBe(old.id);
    expect(getRun(app, old.id).input).toEqual(old.input);
    cancelRun(app, next.id);
    expect(scheduleIngest(app, "personal", [ids[0]], "历史材料")!.id).not.toBe(next.id);
    expect(scheduleIngest(app, "personal", [ids[0]], "只检查决定")!.id).not.toBe(old.id);
    const other = upsertSource(app, { spaceId: "project-a", kind: "note", uri: "other", title: "材料", text: "另一个空间" });
    expect(scheduleIngest(app, "personal", [other.id], "历史材料")!.spaceId).toBe("project-a");
  });
});
