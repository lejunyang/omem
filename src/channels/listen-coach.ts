import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import { createRun, registerHandler, runsInLane } from "../agents/runs.ts";
import { writeWorkFile } from "../sources/work.ts";
import { casesText, playbookOf, playbookPath, type CaseLite } from "./listen-cases.ts";
import { defaultContext, getContext, listContexts, requireContext, saveContext, type ListenContext } from "./listen.ts";
import { briefText } from "./watch-trial.ts";

/**
 * listen-coach: once a 「关注」 has gathered enough cases the owner had a say in (a decision, their own
 * reply, a correction), it files them into scenes and writes the 关注's lessons (a work file, read by the
 * handler, the screening and “someone looks for you”'s triage). A brief that no longer fits goes to the
 * owner to confirm.
 */
export const COACH_AFTER = 5;
const COACH_GAP_MS = 12 * 3600_000;
const lane = (id: string) => `listen-coach:${id}`;

/** Cases the owner had a say in, since the last lessons (or all). */
function freshCases(app: App, c: ListenContext) {
  return one<{ n: number }>(app.db, "select count(*) n from reply_samples where context_id = ? and (decision in ('sent','edited','dropped','disliked') or owner_reply is not null or verdict is not null) and max(created_at, coalesce(decided_at, ''), coalesce(owner_reply_at, '')) > ?", c.id, c.playbookAt ?? "")?.n ?? 0;
}

/** Queue listen-coach for a 关注 (by hand, or when it is due). Returns the run, or null when one is waiting. */
export function queueCoach(app: App, contextId: string) {
  const c = requireContext(app, contextId);
  if (runsInLane(app, lane(c.id)).length) return null;
  return createRun(app, { kind: "listen-coach", spaceId: c.spaceId ?? "personal", lane: lane(c.id), title: `整理关注「${c.name}」的经验`, input: { contextId: c.id } });
}

/** Heartbeat: 关注 with enough new cases and no lessons for a while get their coach run. */
export function coachDue(app: App) {
  defaultContext(app);
  let n = 0;
  for (const c of listContexts(app)) {
    if (c.status !== "active") continue;
    if (c.playbookAt && Date.now() - Date.parse(c.playbookAt) < COACH_GAP_MS) continue;
    if (freshCases(app, c) < COACH_AFTER) continue;
    if (queueCoach(app, c.id)) n++;
  }
  return n;
}

function coachTask(app: App, c: ListenContext) {
  const rows = all<CaseLite>(
    app.db,
    `select id, context_id, chat_id, chat_kind, chat_name, settled_at, asker_id, asker_name, ask, draft, decision, final, reason, owner_reply, verdict, note, scene, checked, created_at
     from reply_samples where context_id = ? and (decision is not null or owner_reply is not null or verdict is not null) order by created_at desc limit 80`,
    c.id,
  );
  const playbook = playbookOf(app, c, 12000);
  return [
    `# 关注「${c.name}」（${c.id}）`,
    "",
    c.kind === "default" ? "这是内置的“有人找你”：所有私聊和 @ 本人的消息。" : `${c.kind === "item" ? "事情型" : "地方型"}关注，${c.chats.length} 个群。`,
    c.note ? `本人要的：${c.note}` : "",
    briefText(c) || "（还没有关注说明）",
    "",
    `## 现在的经验\n\n${playbook || "（还没有，这是第一次整理）"}`,
    "",
    `## 最近的案例（新的在前，共 ${rows.length} 个；[id] 是案例 id）`,
    "",
    casesText(rows) || "（没有）",
    "",
    "按角色说明整理成场景，用 submit_playbook 交完整的新版本；案例不够看出规律就 stay_quiet。",
  ].filter((x) => x !== "").join("\n");
}

registerHandler("listen-coach", async (ctx) => {
  const c = getContext(ctx.app, String(ctx.run.input.contextId));
  if (!c) return { quiet: true, summary: "关注已删除" };
  const { runRole } = await import("../agents/runner.ts");
  const r = await runRole(ctx.app, { role: "listen-coach", spaceId: c.spaceId ?? "personal", task: coachTask(ctx.app, c), runId: ctx.run.id, userId: "owner", signal: ctx.signal, onEvent: (e) => ctx.event(e.type, e) });
  return { quiet: true, text: r.text };
});

export type Scene = { name: string; when: string; reply: "yes" | "no" | "depends"; check?: string; answer?: string; avoid?: string; cases?: string[] };

function render(c: ListenContext, scenes: Scene[], cases: Map<string, CaseLite>, notes?: string) {
  const replyWord = { yes: "要回", no: "不回", depends: "看情况" } as const;
  const example = (id: string) => {
    const x = cases.get(id);
    return x ? `[${id}] ${x.asker_name || "有人"}：${truncate(x.ask.replace(/\s+/g, " "), 60)}${x.owner_reply ? ` → 本人：${truncate(x.owner_reply.replace(/\s+/g, " "), 60)}` : x.decision ? ` → ${x.decision}` : ""}` : `[${id}]`;
  };
  return [
    `# 关注「${c.name}」的经验`,
    "",
    `listen-coach 按以往的案例整理，${now().slice(0, 10)}。和本人这次的话冲突时以本人为准。`,
    ...(notes ? ["", notes.trim()] : []),
    ...scenes.flatMap((s) => [
      "",
      `## ${s.name}`,
      "",
      `- 什么时候：${s.when}`,
      `- 要不要回：${replyWord[s.reply]}`,
      ...(s.check ? [`- 查什么：${s.check}`] : []),
      ...(s.answer ? [`- 怎么回：${s.answer}`] : []),
      ...(s.avoid ? [`- 别这样：${s.avoid}`] : []),
      ...(s.cases?.length ? [`- 例子：${s.cases.slice(0, 5).map(example).join("；")}`] : []),
    ]),
  ].join("\n");
}

/** listen-coach's hand-in (tool submit_playbook): write the lessons, file the cases, and maybe propose a new brief. */
export async function submitPlaybook(app: App, runId: string | null, input: { scenes: Scene[]; case_scenes?: { case: string; scene: string }[]; brief?: { handle: string[]; skip: string[]; valid: string }; notes?: string }) {
  const contextId = runId ? (one<{ c: string | null }>(app.db, "select json_extract(input, '$.contextId') c from runs where id = ? and kind = 'listen-coach'", runId)?.c ?? null) : null;
  if (!contextId) throw new HttpError(403, "只有整理关注经验的运行可以交经验");
  const c = requireContext(app, contextId);
  const ids = [...new Set([...input.scenes.flatMap((s) => s.cases ?? []), ...(input.case_scenes ?? []).map((x) => x.case)])];
  const known = new Map(
    (ids.length ? all<CaseLite>(app.db, `select * from reply_samples where context_id = ? and id in (${ids.map(() => "?").join(",")})`, c.id, ...ids) : []).map((x) => [x.id, x]),
  );
  const text = render(c, input.scenes, known, input.notes);
  const path = playbookPath(c);
  const r = writeWorkFile(app, { spaceId: c.spaceId ?? "personal", path, title: `关注「${c.name}」的经验`, text, runId });
  for (const s of input.scenes) for (const id of s.cases ?? []) if (known.has(id)) run(app.db, "update reply_samples set scene = ? where id = ?", s.name, id);
  for (const x of input.case_scenes ?? []) if (known.has(x.case)) run(app.db, "update reply_samples set scene = ? where id = ?", x.scene, x.case);
  saveContext(app, { id: c.id, kind: c.kind, playbookAt: now(), playbookFile: path });
  let briefNote = "";
  if (input.brief && c.kind !== "default") {
    const same = c.brief && JSON.stringify([c.brief.handle, c.brief.skip, c.brief.valid]) === JSON.stringify([input.brief.handle, input.brief.skip, input.brief.valid]);
    if (!same) {
      saveContext(app, { id: c.id, kind: c.kind, brief: { ...input.brief, at: now() } });
      try {
        const { askBrief } = await import("./watch-trial.ts");
        await askBrief(app, c.id, true);
        briefNote = "新的关注说明已发给本人确认。";
      } catch (e) {
        briefNote = `新的关注说明没能发给本人（${(e as Error).message}）。`;
      }
    }
  }
  const unknown = ids.filter((id) => !known.has(id));
  return `已写好 ${path}（${input.scenes.length} 个场景，${r.lines} 行），${known.size} 个案例标了场景。${unknown.length ? `这些 id 不是这个关注的案例，没有标：${unknown.join("、")}。` : ""}${briefNote}`;
}

/**
 * The owner's own answers in a 关注's groups are cases too, also where the handler never looked (the
 * screening skipped the batch): a reply or quote of someone else's message, by the owner, since the last
 * pass. A case that already holds the asked message gets the owner's words instead of a new one.
 */
export function collectOwnerReplies(app: App) {
  const key = "listen_owner_replies_ms";
  const from = Number(one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value ?? Date.now() - 3600_000);
  let latest = from;
  let n = 0;
  for (const c of listContexts(app, { activeOnly: true })) {
    if (!c.chats.length) continue;
    const mine = all<{ message_id: string; chat_id: string; parent_id: string | null; content: string; create_ms: number }>(
      app.db,
      `select message_id, chat_id, parent_id, content, create_ms from lark_messages where sender_kind = 'owner' and parent_id is not null and create_ms > ?
       and chat_id in (${c.chats.map(() => "?").join(",")}) order by create_ms limit 200`,
      from, ...c.chats,
    );
    for (const m of mine) {
      latest = Math.max(latest, m.create_ms);
      const asked = one<{ sender_name: string; sender_kind: string; content: string }>(app.db, "select sender_name, sender_kind, content from lark_messages where message_id = ?", m.parent_id!);
      if (!asked || asked.sender_kind === "owner" || asked.sender_kind === "app") continue;
      const existing = one<{ id: string }>(app.db, "select id from reply_samples where context_id = ? and instr(message_ids, ?) > 0", c.id, m.parent_id!);
      if (existing) {
        run(app.db, "update reply_samples set owner_reply = coalesce(owner_reply, ?), owner_reply_at = coalesce(owner_reply_at, ?) where id = ?", truncate(m.content, 800), new Date(m.create_ms).toISOString(), existing.id);
        continue;
      }
      const at = now();
      const name = one<{ name: string }>(app.db, "select name from lark_cursors where chat_id = ?", m.chat_id)?.name ?? m.chat_id;
      run(
        app.db,
        `insert into reply_samples(id,channel,chat_id,chat_kind,chat_name,asker_name,ask,message_ids,last_ms,owner_reply,owner_reply_at,settled_at,created_at,context_id,source)
         values(?,'lark',?,'group',?,?,?,?,?,?,?,?,?,?,?)`,
        `rs_own_${m.message_id}`, m.chat_id, name, asked.sender_name, truncate(asked.content, 800), JSON.stringify([m.parent_id]), m.create_ms,
        truncate(m.content, 800), new Date(m.create_ms).toISOString(), at, at, c.id, c.kind === "item" ? "item" : "watch",
      );
      n++;
    }
  }
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, String(latest));
  return n;
}
