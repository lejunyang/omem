/**
 * What plugins add to flows (docs/v2/plugins.md 流程的完成信号 / 插件承担一个阶段 / 阶段完成前的检查):
 * the options `GET /api/flows` lists, a stage's choice of them read from and written into the YAML, the
 * parameters a plugin declares as a JSON Schema, and the words the item's flow shows. Presentation only:
 * the server checks every definition again when it is saved.
 */
import YAML, { isMap, isSeq, type Document } from "yaml";

export type HookOption = { id: string; name: string; describe: string; params?: Record<string, unknown> };
export type GateOption = { id: string; name: string; describe: string; applies?: { flows?: string[]; stages?: string[] } };
export type FlowCheck = { id: string; stages?: string[]; mandatory?: boolean };
export type PendingCheck = { id: string; reason: string };
/** What the page needs of `GET /api/flows` besides the flows. Older servers send none of these. */
export type FlowHooks = { signals: HookOption[]; runners: HookOption[]; gates: GateOption[] };

/** `stagekit:mark` → `stagekit`; built-in names have no plugin. */
export const pluginOf = (id: string) => (id.includes(":") ? id.slice(0, id.indexOf(":")) : null);

// ---- a stage's carrier and completion, in the YAML ---------------------------------------------------

/** A stage as written: only the parts these choices change. */
export type RawStage = { id: string; name?: string; by?: unknown; done?: unknown; budget?: { minutes?: number } & Record<string, unknown> };
export type CarrierChoice = { kind: "owner" } | { kind: "wait" } | { kind: "runner"; id: string; with: Record<string, unknown> } | { kind: "other" };
export type DoneChoice = { kind: "default" } | { kind: "confirm" } | { kind: "signal"; id: string; with: Record<string, unknown> } | { kind: "other" };

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export function carrierOf(s: RawStage): CarrierChoice {
  if (s.by === "owner" || s.by === "wait") return { kind: s.by };
  const by = record(s.by);
  if (typeof by.runner === "string") return { kind: "runner", id: by.runner, with: record(by.with) };
  return { kind: "other" };
}
export function doneOf(s: RawStage): DoneChoice {
  if (s.done === undefined || s.done === null) return { kind: "default" };
  if (s.done === "confirm") return { kind: "confirm" };
  const done = record(s.done);
  if (typeof done.signal === "string") return { kind: "signal", id: done.signal, with: record(done.with) };
  return { kind: "other" };
}
/** Signals (Git's and plugins') are only allowed where the owner does the stage or it only waits (src/flows/definitions.ts). */
export const signalAllowed = (c: CarrierChoice) => c.kind === "owner" || c.kind === "wait";

/** The stages as written, or none when the text does not parse (the server's reading says why). */
export function readStages(raw: string): RawStage[] {
  try {
    const value = YAML.parse(raw) as { stages?: unknown } | null;
    return Array.isArray(value?.stages) ? (value.stages as RawStage[]).filter((s) => s && typeof s.id === "string") : [];
  } catch {
    return [];
  }
}

function stageIndex(doc: Document, id: string) {
  const stages = doc.get("stages");
  if (!isSeq(stages)) return -1;
  return stages.items.findIndex((n) => isMap(n) && n.get("id") === id);
}
/** A small map written on one line (`{ signal: "x:y", with: { file: a.txt } }`), the way the examples write it. */
function flowNode(doc: Document, value: unknown) {
  const node = doc.createNode(value);
  YAML.visit(node, { Map(_, n) { n.flow = true; }, Seq(_, n) { n.flow = true; } });
  return node;
}
/**
 * Change one stage of the YAML text, keeping its comments and the other stages as they were written.
 * `undefined` removes the key. Returns the text unchanged when the stage is not there.
 */
export function setStageKeys(raw: string, id: string, keys: Record<string, unknown>) {
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length) return raw;
  const i = stageIndex(doc, id);
  if (i < 0) return raw;
  for (const [key, value] of Object.entries(keys)) {
    if (value === undefined) doc.deleteIn(["stages", i, key]);
    else doc.setIn(["stages", i, key], typeof value === "object" && value !== null ? flowNode(doc, value) : value);
  }
  return String(doc);
}
const withParams = (params: Record<string, unknown>) => (Object.keys(params).length ? { with: params } : {});
/** The `by` (and `budget.minutes` for a plugin's job) of a carrier choice; `other` leaves the text alone. */
export function writeCarrier(raw: string, s: RawStage, c: CarrierChoice, minutes?: number | null) {
  if (c.kind === "other") return raw;
  const keys: Record<string, unknown> = { by: c.kind === "runner" ? { runner: c.id, ...withParams(c.with) } : c.kind };
  // A time limit belongs to runs and plugin jobs only: you or a wait has none.
  const budget = { ...record(s.budget) };
  if (c.kind === "runner" && minutes) budget.minutes = minutes;
  else delete budget.minutes;
  if (s.budget !== undefined || budget.minutes !== undefined) keys.budget = Object.keys(budget).length ? budget : undefined;
  // A signal stays only where it is allowed.
  if (!signalAllowed(c) && doneOf(s).kind === "signal") keys.done = undefined;
  return setStageKeys(raw, s.id, keys);
}
export function writeDone(raw: string, s: RawStage, d: DoneChoice) {
  if (d.kind === "other") return raw;
  return setStageKeys(raw, s.id, { done: d.kind === "default" ? undefined : d.kind === "confirm" ? "confirm" : { signal: d.id, ...withParams(d.with) } });
}

// ---- parameters: a plugin's JSON Schema as form rows, or a JSON box ----------------------------------

export type ParamField = { key: string; label: string; hint: string; type: "string" | "number" | "integer" | "boolean" | "enum"; options?: string[]; required: boolean; pattern?: string };
/**
 * Form rows for a flat object schema of strings, numbers, booleans and string enums; anything else
 * (nesting, arrays, `oneOf`…) is null and the page falls back to a JSON box.
 */
export function simpleFields(schema: Record<string, unknown> | undefined): ParamField[] | null {
  if (!schema) return [];
  if (schema.type !== "object" || ["oneOf", "anyOf", "allOf", "$ref", "patternProperties"].some((k) => k in schema)) return null;
  const props = record(schema.properties), required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const fields: ParamField[] = [];
  for (const [key, raw] of Object.entries(props)) {
    const p = record(raw);
    const label = typeof p.title === "string" ? p.title : key, hint = typeof p.description === "string" ? p.description : "";
    const base = { key, label, hint, required: required.includes(key) };
    if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string")) fields.push({ ...base, type: "enum", options: p.enum as string[] });
    else if (p.type === "string") fields.push({ ...base, type: "string", ...(typeof p.pattern === "string" ? { pattern: p.pattern } : {}) });
    else if (p.type === "number" || p.type === "integer" || p.type === "boolean") fields.push({ ...base, type: p.type });
    else return null;
  }
  return fields;
}
/** A field's value from a form row: empty text leaves the key out, numbers stay numbers. */
export function fieldValue(f: ParamField, input: string | boolean): unknown {
  if (f.type === "boolean") return input === true;
  const text = String(input).trim();
  if (!text) return undefined;
  if (f.type === "number" || f.type === "integer") { const n = Number(text); return Number.isFinite(n) ? (f.type === "integer" ? Math.round(n) : n) : text; }
  return text;
}
export function setParam(params: Record<string, unknown>, f: ParamField, input: string | boolean) {
  const next = { ...params }, value = fieldValue(f, input);
  // An unticked boolean that is not required is the same as leaving it out.
  if (value === undefined || (f.type === "boolean" && value === false && !f.required)) delete next[f.key];
  else next[f.key] = value;
  return next;
}
/** The JSON box: an object, or the reason it is not one. */
export function parseParams(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; problem: string } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, problem: "参数要写成一个 JSON 对象，比如 {\"file\": \"ready.txt\"}" };
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, problem: `不是合法的 JSON：${(e as Error).message}` };
  }
}

// ---- options for the pickers ------------------------------------------------------------------------

export type Option = { value: string; label: string; hint?: string; group?: string };
/** A plugin's name where we know it (the plugin list), else its id. */
export type PluginNames = Record<string, string>;
const groupOf = (id: string, names: PluginNames) => `插件 · ${names[pluginOf(id) ?? ""] ?? pluginOf(id)}`;
/**
 * The completion choices: the defaults, Git's two, then each plugin's signals under the plugin. A saved
 * signal no plugin offers now stays listed (`停用了`), so the choice is never dropped silently.
 */
export function doneOptions(signals: HookOption[], current: DoneChoice, allowed: boolean, names: PluginNames = {}): Option[] {
  const list: Option[] = [{ value: "default", label: "按谁来做的默认", group: "内置" }, { value: "confirm", label: "做完要你点头", group: "内置" }];
  if (allowed) {
    list.push({ value: "signal:git.pushed", label: "改动推到远端", group: "内置" }, { value: "signal:git.merged", label: "改动合进目标分支", group: "内置" });
    for (const s of signals) list.push({ value: `signal:${s.id}`, label: s.name, hint: s.id, group: groupOf(s.id, names) });
  }
  if (current.kind === "signal" && !list.some((o) => o.value === `signal:${current.id}`))
    list.push({ value: `signal:${current.id}`, label: `${current.id}（停用了）`, group: pluginOf(current.id) ? groupOf(current.id, names) : "内置" });
  if (current.kind === "other") list.unshift({ value: "other", label: "保持定义里写的", group: "内置" });
  return list;
}
export function carrierOptions(runners: HookOption[], current: CarrierChoice, names: PluginNames = {}): Option[] {
  const list: Option[] = [];
  if (current.kind === "other") list.push({ value: "other", label: "保持定义里写的", group: "内置" });
  list.push({ value: "owner", label: "你来做", group: "内置" }, { value: "wait", label: "只等进展", group: "内置" });
  for (const r of runners) list.push({ value: `runner:${r.id}`, label: `插件执行：${r.name}`, hint: r.id, group: groupOf(r.id, names) });
  if (current.kind === "runner" && !runners.some((r) => r.id === current.id))
    list.push({ value: `runner:${current.id}`, label: `${current.id}（停用了）`, group: groupOf(current.id, names) });
  return list;
}
export const doneValue = (d: DoneChoice) => (d.kind === "signal" ? `signal:${d.id}` : d.kind);
export const carrierValue = (c: CarrierChoice) => (c.kind === "runner" ? `runner:${c.id}` : c.kind);

// ---- checks ---------------------------------------------------------------------------------------

/** The checks this flow may use: a plugin can limit its check to some flows. */
export const gatesFor = (gates: GateOption[], flowId: string) => gates.filter((g) => !g.applies?.flows || g.applies.flows.includes(flowId));
/** The stages a check can cover in this flow, by its declared scope. */
export const gateStages = (g: GateOption | undefined, stages: { id: string; name: string }[]) => (g?.applies?.stages ? stages.filter((s) => g.applies!.stages!.includes(s.id)) : stages);
/** Saved checks with ids no plugin offers now: kept and shown, so turning them off is possible. */
export const orphanChecks = (checks: FlowCheck[], gates: GateOption[]) => checks.filter((c) => !gates.some((g) => g.id === c.id));
/** One check switched or changed, in the list that is saved as a whole; `null` turns it off. */
export function putCheck(checks: FlowCheck[], id: string, next: Omit<FlowCheck, "id"> | null): FlowCheck[] {
  const rest = checks.filter((c) => c.id !== id);
  if (!next) return rest;
  const entry: FlowCheck = { id, ...(next.stages?.length ? { stages: next.stages } : {}), mandatory: !!next.mandatory };
  const i = checks.findIndex((c) => c.id === id);
  return i < 0 ? [...rest, entry] : [...checks.slice(0, i), entry, ...checks.slice(i + 1)];
}

// ---- the item's flow ------------------------------------------------------------------------------

export type PluginEvidence = { text: string; link?: string };
export type GateReview = { summary: string; refs: string[]; failed: { id: string; reason: string; evidence?: PluginEvidence[] }[] };
export type WaitingSignal = { type: string; checkedAt: string | null; note: string; available?: boolean; failures?: number; nextAt?: string };
/** Where a piece of evidence opens: an original in the citation drawer, a page here, or a site in a new tab. */
export function evidenceTarget(link: string | undefined): { kind: "cite"; ref: string } | { kind: "route"; path: string } | { kind: "external"; url: string } | null {
  if (!link) return null;
  if (/^src:[\w-]+/.test(link)) return { kind: "cite", ref: link };
  if (link.startsWith("#/")) return { kind: "route", path: link.slice(1) };
  if (/^https?:\/\//i.test(link)) return { kind: "external", url: link };
  return null;
}
/**
 * What a stage waiting for a plugin's signal says: who is asked, and whether it is being answered.
 * `问不到` (the plugin failed) and `没人能判断` (the plugin is gone) are not "in progress".
 */
export function signalState(w: WaitingSignal, name?: string): { tone: "waiting" | "failing" | "gone"; head: string; note: string } {
  const who = name ?? w.type;
  if (w.available === false) return { tone: "gone", head: "等的信号现在没人能判断", note: `${who} 的插件停用了或不在这个空间：你可以自己把这一段做完。` };
  if (w.failures) return { tone: "failing", head: `问不到 ${who}`, note: w.note.replace(/^问不到：/, "") };
  return { tone: "waiting", head: `在等 ${who}`, note: w.note };
}
export const pluginSignal = (w: WaitingSignal | undefined) => !!w && w.type.includes(":");
/**
 * The plugin's job a stage is given to. The item's flow says it only in its carrier's words
 * (src/flows/definitions.ts describeStage: "这个阶段会由插件 <id> 执行：<用途>").
 */
export function runnerOf(label: string | undefined): { id: string; describe: string } | null {
  const m = /^这个阶段会由插件 ([a-z][a-z0-9-]*:[a-z][a-z0-9-]*) 执行：([\s\S]*)$/.exec(label ?? "");
  return m ? { id: m[1], describe: m[2] } : null;
}

// ---- where the progress view lands ---------------------------------------------------------------

/** `?task=T3` on a run page, `?stage=` / `?direction=` / `?trial=` on a flow page (src/agents/progress.ts). Anything else is ignored. */
export function landing(query: Record<string, unknown>): { kind: "task"; seq: number } | { kind: "stage" | "direction" | "trial"; id: string } | null {
  const one = (k: string) => (typeof query[k] === "string" && query[k] ? (query[k] as string) : null);
  const task = one("task");
  if (task) { const m = /^T?(\d{1,6})$/.exec(task); return m ? { kind: "task", seq: Number(m[1]) } : null; }
  for (const kind of ["stage", "direction", "trial"] as const) { const id = one(kind); if (id) return { kind, id }; }
  return null;
}
