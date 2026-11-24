import { ownerCorrections } from "../items/requirements.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { json, now, truncate, localStamp } from "../core/util.ts";
import { isBuiltinRole, listRoleStates, mergeRole, resolveRoleMerge, roleOverrideText, roleSourceText } from "./builtin-roles.ts";
import { askModel } from "./oneshot.ts";
import { profileDetail } from "./profiles.ts";
import { quietReason } from "./quiet.ts";
import { loadRole, runRole } from "./runner.ts";
import { createRun, registerHandler, runsInLane } from "./runs.ts";
import { listAgentSpecs, readAgentSpec } from "./specs.ts";
import { runReactions, runReactionsText } from "../channels/lark-feedback.ts";
import { replayCoachText } from "./replay.ts";
import { casesText, playbookOf, type CaseLite } from "../channels/listen-cases.ts";
import { contextOfConversation, DEFAULT_CONTEXT_ID, getContext } from "../channels/listen.ts";
import { briefText } from "../channels/watch-trial.ts";
import { todayOn } from "../items/today-time.ts";

/**
 * Which runs show a built-in role at work (an agent spec's are its `agent` runs). The assistant's are
 * picked by assistantRuns: the owner's asks, someone looking for the owner, and the 关注 handlers.
 */
const ROLE_RUNS: Record<string, string[]> = {
  assistant: ["ask"],
  ingest: ["ingest"],
  heartbeat: ["heartbeat"],
  coder: ["code"],
  reviewer: ["code"],
  dreamer: ["dream"],
  "memory-reviewer": ["memory-review"],
  "note-reviewer": ["note-review"],
  "memory-organizer": ["memory-organize"],
  "skill-organizer": ["skill-organize"],
  "item-keeper": ["item-settle"],
  "wiki-planner": ["wiki-plan"],
  "wiki-writer": ["wiki-write"],
  "wiki-linter": ["wiki-lint"],
  "wiki-organizer": ["wiki-organize"],
  "wiki-checker": ["wiki-write"],
  tutor: ["tutor"],
  brief: ["brief"],
  curator: ["curate"],
  gatekeeper: ["guest"],
  guest: ["guest"],
  "kb-scout": ["kb-scout"],
  "req-splitter": ["req-split"],
  designer: ["design"],
  "mention-triage": ["mention"],
  "work-state": ["work-state"],
  "first-look": ["first-look"],
};

type EvidenceRun = { id: string; kind: string; status: string; title: string; error: string | null; created_at: string; finished_at: string | null; input: string; output: string | null; lane?: string | null; quiet?: number };

const COLS = "id, kind, status, title, error, created_at, finished_at, input, output, lane, quiet";
const NEGATIVE = "(select count(*) from feedback f where f.run_id = runs.id and f.polarity = 'negative' and f.removed_at is null and f.on_bot = 1)";
/** The run's case (reply_samples.handle_run) shows the owner having a say against it: not sent, edited, disliked, marked, or answered by themselves. */
const CASE_SIGNAL = "exists (select 1 from reply_samples s where s.handle_run = runs.id and (s.decision in ('edited','dropped','disliked') or s.owner_reply is not null or s.verdict is not null))";
/** A turn of a 「关注」's handling conversation (channels/listen.ts): its lane is the conversation. */
const LISTEN_LANE = "lane in (select id from conversations where channel = 'listen')";

/**
 * Besides the owner's own asks, the assistant handles someone looking for the owner (mentions/: `agent`
 * runs with `input.mention`) and the messages of each 「关注」 (`ask` turns in its conversation). Those
 * get a share of their own, the ones whose case the owner corrected first; a quiet one counts when the
 * owner replied where it stayed quiet.
 */
function assistantRuns(app: App, since: string, limit: number): EvidenceRun[] {
  const share = Math.max(1, Math.ceil(limit / 4));
  const order = `order by ${CASE_SIGNAL} desc, ${NEGATIVE} > 0 desc, created_at desc limit ?`;
  const mentions = all<EvidenceRun>(app.db, `select ${COLS} from runs where kind = 'agent' and created_at > ? and json_extract(input, '$.mention') is not null and status in ('done','failed') and (quiet = 0 or ${CASE_SIGNAL}) ${order}`, since, share);
  const listen = all<EvidenceRun>(app.db, `select ${COLS} from runs where kind = 'ask' and created_at > ? and ${LISTEN_LANE} and status in ('done','failed') and (quiet = 0 or ${CASE_SIGNAL}) ${order}`, since, share);
  const asks = all<EvidenceRun>(app.db, `select ${COLS} from runs where kind = 'ask' and created_at > ? and not coalesce(${LISTEN_LANE}, 0) and status in ('done','failed') and quiet = 0 order by ${NEGATIVE} > 0 desc, created_at desc limit ?`, since, Math.max(1, limit - mentions.length - listen.length));
  return [...asks, ...mentions, ...listen];
}

/**
 * The profile's runs since its last review (newest last). Runs someone reacted to negatively come
 * first when there are more than `limit` (lark-feedback.ts), then the newest.
 */
function recentRuns(app: App, name: string, since: string, limit = 12): EvidenceRun[] {
  const rows = name === "assistant"
    ? assistantRuns(app, since, limit)
    : isBuiltinRole(name)
      ? (ROLE_RUNS[name] ?? []).length
        ? all<EvidenceRun>(app.db, `select ${COLS} from runs where kind in (${ROLE_RUNS[name].map(() => "?").join(",")}) and created_at > ? and status in ('done','failed') and quiet = 0 order by ${NEGATIVE} > 0 desc, created_at desc limit ?`, ...ROLE_RUNS[name], since, limit)
        : []
      : all<EvidenceRun>(app.db, `select ${COLS} from runs where kind = 'agent' and json_extract(input, '$.spec') = ? and created_at > ? and status in ('done','failed') order by ${NEGATIVE} > 0 desc, created_at desc limit ?`, name, since, limit);
  return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Which of the assistant's kinds of work a run was: someone looking for the owner, a 关注's handling, or neither. */
function workOf(app: App, r: EvidenceRun): { label: string; contextId: string | null } | null {
  if (r.kind === "agent" && json<{ mention?: unknown }>(r.input, {}).mention) return { label: "有人找你", contextId: DEFAULT_CONTEXT_ID };
  if (r.kind !== "ask" || !r.lane) return null;
  const c = contextOfConversation(app, r.lane);
  return c ? { label: `关注「${c.name}」的处理`, contextId: c.id } : null;
}

/** The cases a run handled (reply_samples.handle_run): what was asked, what it did, what the owner made of it. */
function runCases(app: App, runId: string) {
  return all<CaseLite>(
    app.db,
    `select id, context_id, chat_id, chat_kind, chat_name, settled_at, asker_id, asker_name, ask, draft, decision, final, reason, owner_reply, verdict, note, scene, checked, created_at
     from reply_samples where handle_run = ? order by created_at limit 6`,
    runId,
  );
}

/** Whether a run's case shows the owner correcting it (a signal for the nightly pass, like a correction in chat). */
function caseSignal(app: App, runId: string) {
  return !!one(app.db, `select 1 from runs where id = ? and ${CASE_SIGNAL}`, runId);
}

/** What the run produced that this profile is answerable for. */
function resultOf(name: string, r: EvidenceRun) {
  const out = (r.output ? JSON.parse(r.output) : {}) as Record<string, unknown>;
  if (name === "reviewer") return `评审结论 ${out.verdict ?? "?"}：${String(out.review ?? "")}${out.appliedAt ? "\n（本人应用了这次改动）" : out.discardedAt ? "\n（本人丢弃了这次改动）" : ""}`;
  if (name === "coder") return `${String(out.coderSummary ?? out.summary ?? "")}\n评审 ${out.verdict ?? "?"}${out.appliedAt ? "，本人已应用" : out.discardedAt ? "，本人丢弃" : ""}`;
  return String(out.answer ?? out.summary ?? "");
}

/** The conversation a run answered in, and what the owner said there afterwards. */
function ownerAfter(app: App, r: EvidenceRun) {
  const input = JSON.parse(r.input) as { conversationId?: string; threadId?: string };
  let conv = input.conversationId ?? input.threadId;
  if (!conv) {
    const parent = one<{ input: string }>(app.db, "select p.input from runs c join runs p on p.id = c.parent_id where c.id = ?", r.id);
    conv = parent ? (JSON.parse(parent.input) as { conversationId?: string }).conversationId : undefined;
  }
  if (!conv || !r.finished_at) return [];
  const until = new Date(Date.parse(r.finished_at) + 6 * 3600_000).toISOString();
  // A correction made in the same millisecond the run was marked done still counts (timestamps are
  // millisecond ISO strings; under load they can be equal even though the message came after).
  return all<{ id: string; text: string; created_at: string }>(
    app.db,
    "select id, text, created_at from messages where conversation_id = ? and role = 'user' and created_at >= ? and created_at < ? and json_extract(meta, '$.command') is null order by created_at limit 4",
    conv,
    r.finished_at,
    until,
  );
}

/** A split's nodes as the owner left them: what was corrected or deleted, how many confirmed as written. */
function reqFixesText(app: App, runId: string) {
  const f = ownerCorrections(app, { runId, limit: 12 });
  if (!f.lines.length && !f.confirmed) return "它写的需求点本人还没有处理";
  return `之后本人对它写的需求点：确认 ${f.confirmed} 个${f.lines.length ? `；修改或删除：\n${f.lines.join("\n")}` : "，没有修改"}`;
}

/** The task for the coach: who the profile is, what it knows, and the evidence since last time. */
export function reviewTask(app: App, name: string, since: string) {
  const d = profileDetail(app, name);
  const identity = isBuiltinRole(name) ? (() => { const r = loadRole(name, app); return `内置角色 ${name}${r.customized ? "（本人自定义过）" : ""}：${r.description}\n工具：${r.tools.join(", ") || "无"}\n\n${r.body.trim()}`; })() : (() => { const s = readAgentSpec(app, name); return `Agent 档案 ${name}：${s.description}\n工具：${s.tools.join(", ") || "默认只读"}\n\n${s.prompt}`; })();
  const runs = recentRuns(app, name, since);
  // The 关注 the assistant's runs worked for: their lessons go along once, to check the runs against.
  const contexts = new Set<string>();
  const evidence = runs.map((r) => {
    const work = name === "assistant" ? workOf(app, r) : null;
    if (work?.contextId) contexts.add(work.contextId);
    // A 关注's conversation is the group's messages: what the owner made of the run is in its cases.
    const inGroup = !!work && work.contextId !== DEFAULT_CONTEXT_ID;
    const said = inGroup ? [] : ownerAfter(app, r);
    const cases = work ? runCases(app, r.id) : [];
    return [
      `### ${r.id}（${r.kind}/${r.status}${work ? ` · ${work.label}` : ""}，${localStamp(r.created_at, app.config.timezone)}）${r.title}`,
      r.error ? `错误：${truncate(r.error, 300)}` : "",
      `产出：${truncate(resultOf(name, r).trim() || (r.quiet ? "（没有回复，stay_quiet）" : "（无）"), 1500)}`,
      ...(name === "req-splitter" ? [reqFixesText(app, r.id)] : []),
      ...(work ? [cases.length ? `它处理的案例（本人的取舍、自己回的话、在网页上的纠正）：\n${casesText(cases)}` : "它处理的消息还没有记成案例"] : []),
      said.length ? `之后本人说：\n${said.map((m) => `- msg:${m.id}（${localStamp(m.created_at, app.config.timezone)}）${truncate(m.text.replace(/\s+/g, " "), 400)}`).join("\n")}` : inGroup ? "" : "之后本人没有说什么",
      (() => {
        const r_ = runReactionsText(app, r.id);
        return r_ ? `飞书里对它的回复加的表情：${r_}（确认收到类表情只表示看到了，不算好坏）` : "";
      })(),
    ].filter(Boolean).join("\n");
  });
  // Nightly replay's single-variable comparisons on its questions (agents/replay.ts): reference, small samples.
  const replayed = replayCoachText(app, name);
  const lessons = [...contexts].slice(0, 4).flatMap((id) => {
    const c = getContext(app, id);
    if (!c) return [];
    const text = playbookOf(app, c, 1500);
    return [`## 「${c.name}」${c.id}\n\n${[briefText(c), text ? `经验（listen-coach 按案例写的）：\n${text}` : "（还没有经验）"].filter(Boolean).join("\n\n")}`];
  });
  return {
    runs: runs.length,
    task: [
      `# 复盘对象\n\n${identity}`,
      ...(replayed ? [`# 夜间复盘（近 28 天，只换了一处的重答对比；样本小，同一结论反复出现才算数）\n\n${replayed}`] : []),
      ...(lessons.length ? [`# 这些运行所在关注的说明和经验（对照看运行有没有照着做、本人的取舍和经验有没有矛盾）\n\n${lessons.join("\n\n")}`] : []),
      `# 挂的技能\n\n${d.skills.map((s) => `- ${s.name}：${s.description}`).join("\n") || "（没有）"}`,
      `# 专属记忆\n\n${d.memories.map((m) => `- ${m.id} [${m.kind}] ${truncate(m.content, 200)}`).join("\n") || "（没有）"}`,
      `# 待本人确认的建议\n\n${d.proposals.filter((p) => p.status === "pending").map((p) => `- ${p.id} [${p.kind}] ${p.title}`).join("\n") || "（没有）"}`,
      `# ${since.slice(0, 10)} 以来的运行（${runs.length}）\n\n${evidence.join("\n\n") || "（没有）"}`,
    ].join("\n\n"),
  };
}

registerHandler("profile-review", async (ctx) => {
  const { target } = ctx.run.input as { target: string };
  const key = `profile_review_at:${target}`;
  const since = one<{ value: string }>(ctx.app.db, "select value from kv where key = ?", key)?.value ?? new Date(Date.now() - 14 * 86400_000).toISOString();
  const { runs, task } = reviewTask(ctx.app, target, since);
  run(ctx.app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", key, now());
  if (!runs) return { quiet: true, summary: "上次复盘以来没有它的运行" };
  const before = one<{ n: number }>(ctx.app.db, "select count(*) n from profile_proposals where target = ? and status = 'pending'", target)!.n;
  // Reviewing a profile is not the place to redraft a flow definition (flows/review.ts does that, with the flow's reviews).
  const r = await runRole(ctx.app, { role: "coach", spaceId: ctx.run.spaceId ?? "personal", task, runId: ctx.run.id, signal: ctx.signal, denyTools: ["save_flow", "read_flow_reviews"], onEvent: (e) => ctx.event(e.type, e) });
  run(ctx.app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
  const reason = quietReason(ctx.app, ctx.run.id);
  const summary = r.text.trim() || reason || "";
  const after = one<{ n: number }>(ctx.app.db, "select count(*) n from profile_proposals where target = ? and status = 'pending'", target)!.n;
  // With 今天 on, the proposals wait for the morning card (items/today.ts profilePart).
  if (after > before && !todayOn(ctx.app)) notify(ctx.app, { title: `${target} 有 ${after - before} 条改进建议待确认`, body: truncate(summary, 600), link: `#/agents?tab=agents&name=${target}` });
  return { quiet: !!reason, summary };
});

/** Queue a review of one profile (the page's button, or the nightly pass). */
export function scheduleProfileReview(app: App, target: string) {
  const lane = `profile-review:${target}`;
  const queued = runsInLane(app, lane)[0];
  if (queued) return queued;
  return createRun(app, { kind: "profile-review", spaceId: "personal", title: `复盘 ${target}`, lane, input: { target } });
}

/**
 * Nightly: profiles with at least three runs since their last review (and an owner reaction
 * or a failure among them) get one; at most three a night.
 */
export function nightlyProfileReviews(app: App) {
  const names = [...listAgentSpecs(app).map((s) => s.name), ...listRoleStates(app).map((r) => r.name).filter((n) => ROLE_RUNS[n])];
  let queued = 0;
  for (const name of names) {
    if (queued >= 3) break;
    const since = one<{ value: string }>(app.db, "select value from kv where key = ?", `profile_review_at:${name}`)?.value ?? new Date(Date.now() - 14 * 86400_000).toISOString();
    const runs = recentRuns(app, name, since, 30);
    if (runs.length < 3) continue;
    if (!runs.some((r) => r.status === "failed" || ownerAfter(app, r).length || caseSignal(app, r.id) || runReactions(app, r.id).some((x) => x.actor_kind === "owner" && (x.polarity === "negative" || x.polarity === "positive")))) continue;
    scheduleProfileReview(app, name);
    queued++;
  }
  return queued;
}

/**
 * Merge a customized built-in role with a changed source when `git merge-file` left conflicts:
 * the model reads the owner's copy, the source it was copied from and the new source, and
 * writes the merged file. Checked like any role edit before it is saved.
 */
registerHandler("role-merge", async (ctx) => {
  const { role } = ctx.run.input as { role: string };
  const first = mergeRole(ctx.app, role);
  if (!first.conflicts) return { summary: `${role} 已自动合并源码更新，没有冲突` };
  ctx.event("status", { text: `${first.conflicts} 处冲突，交给模型合并` });
  const prompt = [
    `omem 的内置角色 ${role} 被本人自定义过，之后 omem 更新了这个角色的源码。下面是 git 三方合并的结果，冲突处用 <<<<<<< 自定义 / ||||||| 原版本 / ======= / >>>>>>> 新源码 标出（没有冲突的地方已经合并好）。`,
    "",
    "合并原则：本人有意改动的内容（措辞、偏好、增加的要求）保留；源码新增的能力和规则采用；源码删掉或改写的段落，本人没有改过的就按源码，不要把旧写法和新写法并排留着；两边都改了同一处时把两边的意思合成一段，矛盾时以本人的为准。frontmatter 已经按字段合并好，原样保留，不要改。",
    "",
    "只输出合并后的完整文件内容，从 --- 开始，不要解释，不要代码块围栏，不能留下任何冲突标记。",
    "",
    "## 合并结果（含冲突）",
    "",
    first.text!,
    "",
    "## 参考：本人的自定义版本",
    "",
    roleOverrideText(ctx.app, role) ?? "",
    "",
    "## 参考：新源码",
    "",
    roleSourceText(role),
  ].join("\n");
  const out = await askModel(ctx.app, prompt, { timeoutMs: 10 * 60_000, signal: ctx.signal });
  if (!out) throw new Error("模型没有给出合并结果；可以在 Agent 页手动编辑，或恢复源码版本");
  const text = out.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  resolveRoleMerge(ctx.app, role, `${text}\n`, "agent");
  notify(ctx.app, { title: `内置角色 ${role} 已合并源码更新`, body: `有 ${first.conflicts} 处冲突由模型合并，请在 Agent 页核对（知识库 Git 里有合并前的版本）。`, link: `#/agents?tab=agents&name=${role}` });
  return { summary: `${first.conflicts} 处冲突已由模型合并`, merged: true };
});
