import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { findUser, OWNER, userName } from "./users.ts";
import { HttpError, json, now, truncate } from "./util.ts";
import { listPeers, nodeId, peerJson } from "./peers.ts";
import { sharesFor, peerRead } from "./federation.ts";

/**
 * Several omem working together (docs/v2/mesh.md): each node tells the others who it is and what it
 * has — its assistants, the Agent profiles others may ask, the spaces it shares, the AI it lends —
 * and lets them ask one of its Agents a question. What a caller gets depends on who it is: one of the
 * owner's own devices (the owner's token) sees and may ask everything; another person's server (a
 * service account, federation.ts) only what its grants name (`peer_grants`).
 *
 * The host only carries text that already exists (a profile's description, a space's, an assistant's
 * line about what it is for); what each is good at is not inferred here.
 */

// ---- grants ------------------------------------------------------------------------------

/** What a service account may use besides shared spaces: ask an Agent, borrow an AI backend, see the assistants on the card. */
export type Grant = { kind: "agent" | "ai" | "card"; name: string; daily: number | null };
const GRANT_KINDS = ["agent", "ai", "card"];

export function grantsFor(app: App, userId: string): Grant[] {
  return all<{ kind: string; name: string; daily: number | null }>(app.db, "select kind, name, daily from peer_grants where user_id = ? order by kind, name", userId)
    .map((g) => ({ kind: g.kind as Grant["kind"], name: g.name, daily: g.daily }));
}
/** Replace a service account's grants. */
export function setGrants(app: App, userId: string, grants: { kind: string; name: string; daily?: number | null }[]) {
  const u = findUser(app, userId);
  if (!u || u.kind !== "service") throw new HttpError(400, "只能给别的 omem 的服务账号授权");
  for (const g of grants) if (!GRANT_KINDS.includes(g.kind) || !g.name.trim()) throw new HttpError(400, `授权写法不对：${g.kind}:${g.name}`);
  run(app.db, "delete from peer_grants where user_id = ?", userId);
  for (const g of grants) run(app.db, "insert or replace into peer_grants(user_id, kind, name, daily, created_at) values(?,?,?,?,?)", userId, g.kind, g.name.trim(), g.daily ?? null, now());
  return grantsFor(app, userId);
}
const isOwn = (caller: string) => caller === OWNER;

// ---- the card ----------------------------------------------------------------------------

export type NodeCard = {
  node: string;
  at: string;
  /** How this node sees the caller: one of the owner's own devices, or another person's server. */
  as?: "owner" | "service";
  /** Assistants on the node: whose, and what each is for. */
  assistants?: { name: string; owner: string; description: string; agent: string }[];
  /** Agent profiles the caller may ask (`ask_agent` with `<name>@<node>`). */
  agents?: { name: string; description: string; skills: string[]; daily: number | null }[];
  /** Spaces shared with the caller. */
  spaces?: { id: string; name: string; description: string; mode: string }[];
  /** AI backends the caller may borrow. */
  ai?: { id: string; model: string | null; daily: number | null; left: number | null }[];
};

/** This node as `caller` may see it. */
export async function nodeCard(app: App, caller: string): Promise<NodeCard> {
  const own = isOwn(caller);
  const grants = own ? [] : grantsFor(app, caller);
  const card: NodeCard = { node: nodeId(app), at: now(), as: own ? "owner" : "service" };
  if (own || grants.some((g) => g.kind === "card" && g.name === "assistants")) {
    const { listAssistants } = await import("../agents/assistants.ts");
    card.assistants = (await listAssistants(app)).filter((a) => a.enabled).map((a) => ({ name: a.name, owner: a.userName, description: a.description, agent: a.agent }));
  }
  const { listAgentSpecs } = await import("../agents/specs.ts");
  const specs = listAgentSpecs(app).filter((s) => s.status === "active");
  const asked = new Map(grants.filter((g) => g.kind === "agent").map((g) => [g.name, g.daily]));
  const agents = specs.filter((s) => own || asked.has(s.name)).map((s) => ({ name: s.name, description: s.description, skills: (s.skills ?? []).slice(0, 12), daily: asked.get(s.name) ?? null }));
  if (own || asked.has("assistant")) agents.unshift({ name: "assistant", description: own ? "主助手：这台 omem 的通用助理，熟悉它的空间" : "这台 omem 的助理：按共享给你的空间查资料回答（只读）", skills: [], daily: asked.get("assistant") ?? null });
  if (agents.length) card.agents = agents;
  const spaces = sharesFor(app, caller).map((s) => ({ id: s.space, name: s.name, description: one<{ description: string }>(app.db, "select description from spaces where id = ?", s.space)?.description ?? "", mode: s.mode }));
  if (spaces.length) card.spaces = own ? spaces.slice(0, 60) : spaces;
  const { allProfiles } = await import("./config.ts");
  const lent = new Map(grants.filter((g) => g.kind === "ai").map((g) => [g.name, g.daily]));
  // What can be opened from elsewhere: this node's own ACP backends (core/peer-acp.ts servableAgent).
  const ai = allProfiles(app.config).filter((p) => !p.peer && p.transport === "acp" && (own || lent.has(p.id)))
    .map((p) => ({ id: p.id, model: p.model ?? null, daily: lent.get(p.id) ?? null, left: lent.get(p.id) ? Math.max(0, lent.get(p.id)! - lentToday(app, caller, p.id)) : null }));
  if (ai.length) card.ai = ai;
  return card;
}

// ---- the others' cards -------------------------------------------------------------------

export type KnownCard = { peer: string; card: NodeCard | null; at: string; error?: string };
const cardKey = (peer: string) => `mesh_card:${peer}`;

/** Ask every paired node for its card (a few seconds each at most); what does not answer keeps its last card, marked. */
export async function refreshCards(app: App, opts: { timeoutMs?: number } = {}): Promise<KnownCard[]> {
  await Promise.all(listPeers(app).map(async (p) => {
    const prev = json<KnownCard | null>(one<{ value: string }>(app.db, "select value from kv where key = ?", cardKey(p.id))?.value, null);
    let next: KnownCard;
    try {
      next = { peer: p.id, card: await peerJson<NodeCard>(app, p.id, "/api/fed/card", undefined, opts.timeoutMs ?? 8000), at: now() };
    } catch (e) {
      next = { peer: p.id, card: prev?.card ?? null, at: prev?.at ?? now(), error: (e as Error).message.slice(0, 200) };
    }
    run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", cardKey(p.id), JSON.stringify(next));
  }));
  return knownCards(app);
}
/** The cards last received, of the nodes still paired. */
export function knownCards(app: App): KnownCard[] {
  const paired = new Set(listPeers(app).map((p) => p.id));
  return all<{ value: string }>(app.db, "select value from kv where key like 'mesh_card:%'").map((r) => json<KnownCard | null>(r.value, null)).filter((c): c is KnownCard => !!c && paired.has(c.peer));
}

let timer: NodeJS.Timeout | null = null;
/** Look again every ten minutes while there is anyone to look at. */
export function startMesh(app: App) {
  if (timer) clearInterval(timer);
  const tick = () => {
    if (listPeers(app).length) void refreshCards(app).catch(() => {});
  };
  timer = setInterval(tick, 10 * 60_000);
  timer.unref();
  setTimeout(tick, 5_000).unref();
}

/** For the owner's assistant: who else is on the network and what to go to them for. Empty when nobody is. */
export function meshNote(app: App) {
  const cards = knownCards(app).filter((c) => c.card && (c.card.agents?.length || c.card.spaces?.length || c.card.assistants?.length));
  if (!cards.length) return "";
  const lines = cards.slice(0, 8).map((c) => {
    const k = c.card!;
    const parts = [
      k.agents?.length ? `可以请教的 Agent：${k.agents.slice(0, 8).map((a) => `${a.name}（${truncate(a.description, 50)}）`).join("、")}` : "",
      k.assistants?.length ? `那里的助手：${k.assistants.slice(0, 6).map((a) => `${a.name}（${a.owner}的${a.description ? `，${truncate(a.description, 40)}` : ""}）`).join("、")}` : "",
      k.spaces?.length ? `共享的空间：${k.spaces.slice(0, 10).map((s) => `${s.name}${s.description ? `（${truncate(s.description, 30)}）` : ""}`).join("、")}` : "",
      k.ai?.length ? `可借的 AI：${k.ai.map((a) => a.id).join("、")}` : "",
    ].filter(Boolean);
    return `- 「${c.peer}」${c.error ? "（这会儿连不上，下面是上次看到的）" : ""}：${parts.join("；")}`;
  });
  return ["网络里还有别的 omem。问题属于对方的领域、资料和经验都在对方那边时，用 ask_agent 请教它的 Agent，name 写「档案@节点」（如 assistant@" + cards[0].peer + "）；只要查它共享的资料用 peer_search。", ...lines].join("\n");
}

// ---- asking an Agent of another node -----------------------------------------------------

const today = (app: App) => new Date(`${new Date().toLocaleDateString("sv-SE", { timeZone: app.config.timezone })}T00:00:00`).toISOString();

/**
 * Another node asks one of this node's Agents (POST /api/fed/ask). It runs here, with this node's AI
 * and what the caller may read here, with read-only tools; the caller looks for the answer by the
 * run's id (the answer can take longer than a forwarded request waits).
 */
export async function fedAsk(app: App, caller: string, input: { agent: string; question: string; from?: { run?: string; asker?: string } }) {
  const own = isOwn(caller);
  const grant = own ? null : grantsFor(app, caller).find((g) => g.kind === "agent" && g.name === input.agent);
  if (!own && !grant) throw new HttpError(403, `这台 omem 没有开放 Agent ${input.agent}`);
  if (grant?.daily) {
    const used = one<{ n: number }>(app.db, "select count(*) n from runs where kind = 'agent' and json_extract(input, '$.fedAsk.node') = ? and json_extract(input, '$.fedAsk.agent') = ? and created_at > ?", caller, input.agent, today(app))?.n ?? 0;
    if (used >= grant.daily) throw new HttpError(429, `今天请教 ${input.agent} 的次数用完了（每天 ${grant.daily} 次）`);
  }
  const { findAgentSpec } = await import("../agents/specs.ts");
  const spec = input.agent === "assistant" ? undefined : findAgentSpec(app, input.agent);
  if (input.agent !== "assistant" && (!spec || spec.status !== "active")) throw new HttpError(404, `没有 Agent 档案 ${input.agent}`);
  const spaces = sharesFor(app, caller).map((s) => s.space);
  if (!own && !spaces.length) throw new HttpError(403, "没有共享给你的空间，Agent 没有资料可查");
  const { peerToolNames } = await import("../agents/peer-agent.ts");
  const { toolList } = await import("../agents/tools.ts");
  const readOnly = peerToolNames({ readOnly: true });
  for (const t of ["peer_search", "peer_read"]) readOnly.delete(t);
  const denyTools = toolList().map((t) => t.name).filter((n) => !readOnly.has(n));
  const who = own ? "本人的另一台设备" : userName(app, caller);
  const { consultAgent } = await import("../agents/consult.ts");
  const runId = await new Promise<string>((resolve, reject) => {
    consultAgent(app, {
      // Another person's server asking the assistant gets the guest role: what is shared with it, read-only,
      // without the owner's preferences, memories or skills. A granted profile answers as itself.
      ...(spec ? { spec } : { role: own ? ("assistant" as const) : ("guest" as const) }),
      label: input.agent,
      question: input.question,
      askedBy: `${who}（另一台 omem）`,
      parentRunId: null,
      spaceId: spec?.space && (own || spaces.includes(spec.space)) ? spec.space : spaces[0] ?? "personal",
      extra: { denyTools, ...(own ? {} : { spaces, readScope: spaces }) },
      input: { fedAsk: { agent: input.agent, node: caller, ...(input.from ?? {}) } },
      trigger: { via: "peer", by: { key: `user:${caller}`, name: who }, where: who },
      onStart: resolve,
    }).catch(reject);
  });
  return { runId };
}

/** The answer to a question asked through fedAsk, for the caller that asked it. */
export function fedAnswer(app: App, caller: string, runId: string) {
  const r = one<{ status: string; output: string; error: string | null; user_id: string | null; input: string }>(app.db, "select status, output, error, user_id, input from runs where id = ?", runId);
  if (!r || json<{ fedAsk?: { node?: string } }>(r.input, {}).fedAsk?.node !== caller) throw new HttpError(404, "没有这次请教");
  return { status: r.status, answer: r.status === "done" ? String(json<{ answer?: string }>(r.output, {}).answer ?? "") : null, error: r.error };
}

/**
 * Ask an Agent of another node and wait for its answer (`ask_agent` with `<agent>@<node>`). The
 * originals it cites are brought here where this node follows the space they are in, so the citation
 * opens here; the rest are left as the other node's ids and said so.
 */
export async function askPeerAgent(app: App, peer: string, agent: string, question: string, opts: { runId?: string | null; asker?: string; signal?: AbortSignal; pollMs?: number; maxMs?: number } = {}) {
  const started = await peerJson<{ runId: string }>(app, peer, "/api/fed/ask", { agent, question, from: { run: opts.runId ?? undefined, asker: opts.asker } }, 30_000);
  const until = Date.now() + (opts.maxMs ?? 15 * 60_000);
  for (;;) {
    if (opts.signal?.aborted) throw new Error("已取消");
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 4000));
    const a = await peerJson<{ status: string; answer: string | null; error: string | null }>(app, peer, `/api/fed/ask/${encodeURIComponent(started.runId)}`, undefined, 20_000).catch(() => null);
    if (a?.status === "done") return { remoteRun: started.runId, ...(await landCitations(app, peer, a.answer ?? "")) };
    if (a && (a.status === "failed" || a.status === "cancelled")) throw new Error(`${agent}@${peer} 没有答成：${a.error ?? a.status}`);
    if (Date.now() > until) throw new Error(`${agent}@${peer} 超过 ${Math.round((opts.maxMs ?? 15 * 60_000) / 60_000)} 分钟还没答完（对方的运行 ${started.runId} 还在）`);
  }
}

/** `src:<their id>` in an answer from another node → this node's copy where the source can be brought here. */
async function landCitations(app: App, peer: string, text: string) {
  const ids = [...new Set([...text.matchAll(/src:([A-Za-z0-9_-]{6,})/g)].map((m) => m[1]))].slice(0, 30);
  const local = new Map<string, string>();
  await Promise.all(ids.map(async (id) => {
    try {
      local.set(id, (await peerRead(app, peer, id)).id);
    } catch {}
  }));
  const missed = ids.filter((id) => !local.has(id));
  const answer = text.replace(/src:([A-Za-z0-9_-]{6,})/g, (m, id: string) => (local.has(id) ? `src:${local.get(id)}` : m));
  return { answer, landed: local.size, missed };
}

// ---- lending an AI backend ---------------------------------------------------------------

const lendKey = (app: App, userId: string, backend: string) => `mesh_ai:${userId}:${backend}:${new Date().toLocaleDateString("sv-SE", { timeZone: app.config.timezone })}`;
/** Connections another person's server opened to a lent backend today. */
export function lentToday(app: App, userId: string, backend: string) {
  return Number(one<{ value: string }>(app.db, "select value from kv where key = ?", lendKey(app, userId, backend))?.value ?? 0);
}
/**
 * Another person's server opens one of this node's ACP backends (`/api/peer/acp`, core/peer-acp.ts):
 * allowed by an `ai:<backend>` grant, within its uses a day; each allowed connection counts as one.
 * The model runs here; the tools stay on the caller's side (its knowledge, its permissions).
 */
export function lendAllowed(app: App, userId: string, backend: string): { ok: boolean; reason?: string } {
  const g = grantsFor(app, userId).find((x) => x.kind === "ai" && x.name === backend);
  if (!g) return { ok: false, reason: `没有借出后端 ${backend}` };
  const used = lentToday(app, userId, backend);
  if (g.daily && used >= g.daily) return { ok: false, reason: `今天借用 ${backend} 的次数用完了（每天 ${g.daily} 次）` };
  run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", lendKey(app, userId, backend), String(used + 1));
  return { ok: true };
}

/** A space kept on this machine only (settings.local): not shared, not synced, never handed to an AI borrowed from someone else's server. */
export function localOnly(app: App, spaceId: string) {
  return !!(json<{ local?: boolean }>(one<{ settings: string }>(app.db, "select settings from spaces where id = ?", spaceId)?.settings, {}).local);
}
/** A backend that is another person's server's AI (not one of the owner's own devices'): unknown counts as theirs. */
export function lentByOthers(app: App, profile: { peer?: { id: string } }) {
  if (!profile.peer) return false;
  return knownCards(app).find((c) => c.peer === profile.peer!.id)?.card?.as !== "owner";
}
