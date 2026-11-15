import type { App } from "./app.ts";
import { all, one, run, tx } from "./db.ts";
import { decide, describeDecision, type DecisionQuestion, type DecisionResult } from "./decision.ts";
import { DECISION_SCENES, type DecisionScene, type DecisionReport } from "./decision-scenes.ts";
import { json, newId, now } from "./util.ts";

export { DECISION_SCENES, type DecisionScene } from "./decision-scenes.ts";
type Material = string | Record<string, unknown>;
export type SceneResult = DecisionResult & { taken: string; lowered: boolean; id: string; threshold: number };
type Label = "needed" | "unneeded" | "unclear";
type Verdict = { label: Label; why: string };
export type DecisionRow = {
  id: string; at: string; scene: DecisionScene; by: string; question: string; material: string;
  probabilities: string; choice: string; taken: string; threshold: number; ref: string | null;
  sources: string; label: Label | null;
};
const DAY = 86400_000;
const iso = (ms: number) => new Date(ms).toISOString();
export const sceneThreshold = (app: App, scene: DecisionScene) => app.config.ai.decision.thresholds?.[scene] ?? DECISION_SCENES[scene].default;
export function takeDecision(scene: DecisionScene, r: Pick<DecisionResult, "choice" | "probabilities">, threshold: number) {
  const s = DECISION_SCENES[scene];
  // Missing or invalid confidence cannot authorise the risky option.
  return r.choice === s.risky && !(r.probabilities[r.choice] >= threshold) ? s.cautious : r.choice;
}

/** Keep valid JSON and every named part; escaped characters also count toward the cap. */
function capMaterial(material: Material): string {
  if (typeof material === "string") {
    let text = material.slice(0, 11900);
    while (JSON.stringify(text).length > 12000) text = text.slice(0, Math.floor(text.length * 0.9));
    return JSON.stringify(text);
  }
  const entries = Object.entries(material);
  const budget = Math.max(0, Math.floor(11000 / Math.max(1, entries.length)));
  let parts = entries.map(([k, v]) => [k.slice(0, 120), typeof v === "string" ? v.slice(0, budget) : JSON.stringify(v)?.slice(0, budget) ?? ""]);
  // Pathological numbers of keys still have a bounded representation.
  parts = parts.slice(0, 100);
  let result = JSON.stringify(Object.fromEntries(parts));
  while (result.length > 12000) {
    const longKeys = JSON.stringify(Object.fromEntries(parts.map(([k]) => [k, ""]))).length > 10000;
    parts = parts.map(([k, v]) => [longKeys ? k.slice(0, Math.max(1, Math.floor(k.length * 0.8))) : k, v.slice(0, Math.floor(v.length * 0.8))]);
    result = JSON.stringify(Object.fromEntries(parts));
  }
  return result;
}

export async function decideScene(app: App, scene: DecisionScene, material: Material, question: DecisionQuestion,
  opts: NonNullable<Parameters<typeof decide>[3]> & { ref?: string; sources?: string[] } = {}): Promise<SceneResult | null> {
  const { ref, sources, ...ask } = opts;
  const r = await decide(app, material, question, ask);
  if (!r) return null;
  const threshold = sceneThreshold(app, scene);
  const taken = takeDecision(scene, r, threshold);
  const id = newId("d");
  run(app.db, `insert into decisions(id,at,scene,"by",question,material,probabilities,choice,taken,threshold,ref,sources)
    values(?,?,?,?,?,?,?,?,?,?,?,?)`, id, now(), scene, r.by, JSON.stringify(question), capMaterial(material), JSON.stringify(r.probabilities), r.choice, taken, threshold, ref ?? null, JSON.stringify(scene === "heartbeat" ? [...new Set(sources ?? [])] : []));
  return { ...r, taken, lowered: taken !== r.choice, id, threshold };
}

export function describeScene(r: SceneResult, labels: Record<string, string>) {
  const said = describeDecision(r, labels);
  return r.lowered ? `${said}，把握不到 ${r.threshold}，按${labels[r.taken] ?? r.taken}处理` : said;
}

/** Called by swept only for sources actually handed to that run. */
export function recordDecisionSweep(app: App, sources: string[], runId: string) {
  tx(app.db, () => {
    for (const source of sources) run(app.db, "insert or ignore into decision_sweeps(source_id,run_id,at) values(?,?,?)", source, runId, now());
  });
}
type EndedRun = { status: string; finished_at: string | null; input: string; output: string | null };
const runOf = (app: App, id: string | null) => id ? one<EndedRun>(app.db, "select status, finished_at, input, output from runs where id = ?", id) : undefined;
const ended = (r: EndedRun | undefined) => !!r?.finished_at && !["queued", "running"].includes(r.status);
type Notice = { outcome: string | null; context: string };
const notices = (app: App, ref: string) => all<Notice>(app.db, "select outcome,context from notifications where json_extract(context, '$.runId') = ? and user_id = 'owner' and coalesce(json_extract(context, '$.urgency'), '') != 'silent' and json_extract(context, '$.replacedBy') is null", ref);
const itemChanges = (app: App, ref: string) => all<{ source_refs: string; item_refs: string }>(app.db, "select e.source_refs, i.source_refs item_refs from item_events e join items i on i.id = e.item_id where e.run_id = ? and e.kind != 'reminded'", ref);
const needed = (why: string): Verdict => ({ label: "needed", why });
const unneeded = (why: string): Verdict => ({ label: "unneeded", why });
const unclear = (why: string): Verdict => ({ label: "unclear", why });

function labelHeartbeatLook(app: App, d: DecisionRow): Verdict | null {
  const r = runOf(app, d.ref);
  if (!ended(r)) return Date.now() - Date.parse(d.at) >= 3 * DAY ? unclear("巡检没有完成结果") : null;
  if (notices(app, d.ref!).length || itemChanges(app, d.ref!).length) return needed("巡检发了提醒或更新了事项");
  return r!.status === "done" ? unneeded("巡检后没有要说的") : unclear("巡检未正常完成");
}
const sourceId = (ref: string) => ref.replace(/^src:/, "").split("#")[0];
function labelHeartbeatSkip(app: App, d: DecisionRow): Verdict | null {
  const ids = json<string[]>(d.sources, []);
  const expired = Date.now() - Date.parse(d.at) >= 3 * DAY;
  if (!ids.length) return expired ? unclear("没有可补看的来源") : null;
  let complete = true;
  let deleted = false;
  for (const id of ids) {
    const sweep = one<{ run_id: string }>(app.db, "select run_id from decision_sweeps where source_id = ? and at >= ? and at <= ? order by at limit 1", id, d.at, iso(Date.parse(d.at) + 3 * DAY));
    const r = sweep ? runOf(app, sweep.run_id) : undefined;
    if (sweep && ended(r)) {
      const cited = notices(app, sweep.run_id).some((n) => json<{ sourceRefs?: string[] }>(n.context, {}).sourceRefs?.some((ref) => sourceId(ref) === id)) || itemChanges(app, sweep.run_id).some((e) => [...json<string[]>(e.source_refs, []), ...json<string[]>(e.item_refs, [])].some((ref) => sourceId(ref) === id));
      if (cited) return needed("补看时发现要告诉本人");
      if (r!.status !== "done") complete = false;
    } else complete = false;
    if (!one(app.db, "select 1 from sources where id = ? and deleted_at is null", id)) deleted = true;
  }
  if (complete) return unneeded("补看时没有要说的");
  return expired || deleted ? unclear(deleted ? "跳过的来源已删除" : "三天内没有完成补看") : null;
}

function labelTriageNotify(app: App, d: DecisionRow): Verdict | null {
  const r = runOf(app, d.ref);
  const handleRun = json<{ handleRun?: string }>(r?.output ?? null, {}).handleRun;
  const found = [...(d.ref ? notices(app, d.ref) : []), ...(handleRun ? notices(app, handleRun) : [])];
  if (found.some((n) => n.outcome === "acted")) return needed("提醒后本人处理了");
  if (found.some((n) => n.outcome === null)) return Date.now() - Date.parse(d.at) >= 7 * DAY ? unclear("提醒一直没有结果") : null;
  if (found.some((n) => n.outcome === "negative" || n.outcome === "unread")) return unneeded("提醒后本人没看或表示反感");
  if (found.length) return unclear("提醒后只看过、已经知道或合并发送");
  return Date.now() - Date.parse(d.at) >= 3 * DAY ? unclear("三天内没有发出提醒") : null;
}

function labelTriageIgnore(app: App, d: DecisionRow): Verdict | null {
  if (Date.now() - Date.parse(d.at) < 2 * DAY) return null;
  const input = json<{ chatId?: string; messageIds?: string[]; channel?: string }>(runOf(app, d.ref)?.input ?? null, {});
  if (!input.chatId || (input.channel && input.channel !== "lark")) return unclear("没有飞书会话和消息时间");
  // Message IDs are bounded by the run input; each lookup uses the primary key.
  const messages = (input.messageIds ?? []).flatMap((id) => one<{ create_ms: number }>(app.db, "select create_ms from lark_messages where message_id = ? and chat_id = ?", id, input.chatId!) ?? []);
  if (!messages.length) return unclear("原消息已不可用");
  const signature = app.config.lark.commands.signature.trim();
  const replied = messages.some((m) => one(app.db, `select 1 from lark_messages where chat_id = ? and create_ms > ? and create_ms <= ? and sender_kind = 'owner'
    and msg_type in ('text','post') and trim(content) != '' and (? = '' or instr(content, ?) = 0) limit 1`, input.chatId!, m.create_ms, m.create_ms + DAY, signature, signature));
  return replied ? needed("忽略后本人在会话里回复了") : unneeded("忽略后一天内本人没有回复");
}

/** At most 200 decisions, retry fairly, and expire old private material in bounded deletes. */
export function labelDecisions(app: App, { limit = 200 } = {}) {
  const size = Number.isFinite(limit) ? Math.max(0, Math.min(200, Math.floor(limit))) : 200;
  const at = now();
  const rows = all<DecisionRow>(app.db, `select * from decisions where label is null and scene in ('heartbeat','triage') and next_label_at <= ? order by next_label_at, at limit ?`, at, size);
  tx(app.db, () => {
    for (const d of rows) {
      const v = d.scene === "heartbeat" ? (d.taken === "yes" ? labelHeartbeatLook(app, d) : labelHeartbeatSkip(app, d)) : d.taken === "ignore" ? labelTriageIgnore(app, d) : labelTriageNotify(app, d);
      if (v) run(app.db, "update decisions set label=?, label_why=?, labelled_at=? where id=?", v.label, v.why, at, d.id);
      else run(app.db, "update decisions set next_label_at=? where id=?", iso(Date.now() + 15 * 60_000), d.id);
    }
    run(app.db, "delete from decisions where id in (select id from decisions where at < ? order by at limit ?)", iso(Date.now() - 90 * DAY), size);
    run(app.db, "delete from decision_sweeps where rowid in (select rowid from decision_sweeps where at < ? order by at limit ?)", iso(Date.now() - 90 * DAY), size);
  });
  return rows.length;
}

const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];
const enough = "有结果的记录还不到 20 条，先按现在的门槛";
export function decisionReport(app: App, { days = 30 } = {}): DecisionReport {
  days = Math.max(1, Math.min(90, Math.floor(days) || 30));
  const scenes = (Object.entries(DECISION_SCENES) as [DecisionScene, typeof DECISION_SCENES[DecisionScene]][]).map(([scene, s]) => {
    // Aggregates stay in SQLite; no material or questions enter the report.
    const base = one<{ records: number; risky: number; lowered: number; needed: number; unneeded: number; unclear: number; misses: number; wasted: number; labelledRiskyChoices: number }>(app.db, `select count(*) records,
      coalesce(sum(taken = ?),0) risky, coalesce(sum(choice != taken),0) lowered,
      coalesce(sum(label = 'needed'),0) needed, coalesce(sum(label = 'unneeded'),0) unneeded, coalesce(sum(label = 'unclear'),0) unclear,
      coalesce(sum(taken = ? and label = 'needed'),0) misses, coalesce(sum(taken = ? and label = 'unneeded'),0) wasted,
      coalesce(sum(choice = ? and label in ('needed','unneeded')),0) labelledRiskyChoices
      from decisions where scene = ? and at >= ?`, s.risky, s.risky, s.cautious, s.risky, scene, iso(Date.now() - days * DAY))!;
    const thresholds = THRESHOLDS.map((threshold) => {
      const counts = one<{ risky: number; labelled: number; misses: number }>(app.db, `select count(*) risky,
        coalesce(sum(label in ('needed','unneeded')),0) labelled, coalesce(sum(label = 'needed'),0) misses from decisions
        where scene = ? and at >= ? and choice = ? and json_extract(probabilities, ?) >= ?`, scene, iso(Date.now() - days * DAY), s.risky, `$.${s.risky}`, threshold)!;
      return { threshold, ...counts };
    });
    const suggested = thresholds.find((t) => base.labelledRiskyChoices >= 20 && t.labelled > 0 && t.misses / t.labelled <= 0.05)?.threshold ?? null;
    const labelsEnabled = scene === "heartbeat" || scene === "triage";
    return { scene, ...s, threshold: sceneThreshold(app, scene), ...base, labelled: base.needed + base.unneeded + base.unclear, labelsEnabled, thresholds, suggested: labelsEnabled ? suggested : null,
      suggestion: !labelsEnabled ? "这个场景只记录，不标注结果" : base.labelledRiskyChoices < 20 ? enough : suggested === null ? "已知漏看仍超过 5%，先按现在的门槛" : `可考虑门槛 ${suggested}，只供参考，不会自动修改` };
  });
  return { days, scenes };
}
export type { DecisionReport } from "./decision-scenes.ts";

export async function replayDecisions(app: App, { scene, model, days = 30, limit = 200 }: { scene: DecisionScene; model: string; days?: number; limit?: number }) {
  if (!Object.hasOwn(DECISION_SCENES, scene)) throw new Error("未知决策场景");
  const colon = model.indexOf(":");
  if (colon < 1 || !model.slice(colon + 1).trim()) throw new Error("模型写成 <提供方 ID>:<模型>");
  const only = { provider: model.slice(0, colon), model: model.slice(colon + 1) };
  const rows = all<DecisionRow>(app.db, "select * from decisions where scene = ? and at >= ? order by at desc limit ?", scene, iso(Date.now() - Math.max(1, Math.min(90, days)) * DAY), Math.max(1, Math.min(200, Math.floor(limit))));
  const threshold = sceneThreshold(app, scene);
  const original = { misses: 0, wasted: 0 }, candidate = { misses: 0, wasted: 0 };
  let compared = 0, agreement = 0, takenAgreement = 0, errors = 0, consecutive = 0;
  const models = new Set<string>();
  const count = (stats: typeof original, taken: string, label: Label | null) => {
    if (taken === DECISION_SCENES[scene].risky && label === "needed") stats.misses++;
    if (taken === DECISION_SCENES[scene].cautious && label === "unneeded") stats.wasted++;
  };
  for (const d of rows) {
    try {
      const r = await decide(app, JSON.parse(d.material) as Material, JSON.parse(d.question) as DecisionQuestion, { only });
      if (!r) throw new Error("候选模型不可用");
      const taken = takeDecision(scene, r, threshold);
      const old = takeDecision(scene, { choice: d.choice, probabilities: JSON.parse(d.probabilities) }, threshold);
      models.add(d.by);
      compared++; agreement += Number(d.choice === r.choice); takenAgreement += Number(old === taken);
      count(original, old, d.label); count(candidate, taken, d.label);
      consecutive = 0;
    } catch { errors++; if (++consecutive >= 3) break; }
  }
  return { scene, threshold, selected: rows.length, compared, agreement, takenAgreement, errors, stopped: consecutive >= 3,
    original: { models: [...models], ...original }, candidate: { model, ...candidate } };
}

export function decisionReportText(report: DecisionReport) {
  return [`最近 ${report.days} 天的决策记录（已知结果仅供校准）`, ...report.scenes.flatMap((s) => [
    `${s.label}：${s.records} 条，放行 ${s.risky}，门槛改判 ${s.lowered}；有结果 ${s.labelled}（需要 ${s.needed} / 不需要 ${s.unneeded} / 不明确 ${s.unclear}），漏看 ${s.misses}，多看 ${s.wasted}`,
    ...s.thresholds.map((t) => `  门槛 ${t.threshold}：放行 ${t.risky}，已知漏看 ${t.misses} / 有结果的 ${t.labelled}`), `  ${s.suggestion}`,
  ])].join("\n");
}
