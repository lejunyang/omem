import type { App } from "../core/app.ts";
import { saveConfig } from "../core/config.ts";
import { one } from "../core/db.ts";
import { OWNER, userName } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { findAgentSpec } from "./specs.ts";

/**
 * Assistants (docs/v2/mesh.md §7): each is someone's — the owner's main assistant (the main bot), and
 * the bots of `lark.bots`, which belong to the owner or to a member (`userId`). An assistant has a name
 * and a line about what it is for (what others, and other nodes, know it by), the Agent profile that
 * answers, and optionally a daily limit the owner sets. A member's assistant runs as that member: the
 * person its bot knows as its creator is that member, so its turns read what the member may read.
 *
 * They are kept where the bots already are (the `lark.bots` setting and the app secrets file), not in
 * a table of their own: an assistant without a bot is an Agent profile used on the web.
 */
export type Assistant = {
  /** "main", or the bot's id in lark.bots. */
  id: string;
  name: string;
  description: string;
  userId: string;
  userName: string;
  /** "assistant" (the main assistant's role) or an Agent profile. */
  agent: string;
  enabled: boolean;
  appId: string | null;
  /** Its bot is connected to Feishu now. */
  connected: boolean;
  dailyRuns: number | null;
  todayRuns: number;
  /** The id its bot knows its owner by (each Feishu app has its own). */
  ownerOpenId: string | null;
};

type Bot = App["config"]["lark"]["bots"][number];
const ownerOf = (b: Bot) => b.userId ?? OWNER;
/** The conversation channel of an assistant's bot. */
const channelOf = (id: string) => (id === "main" ? "lark" : `lark:${id}`);

/** Turns today in the conversations of one bot. */
function todayRuns(app: App, id: string) {
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: app.config.timezone });
  const since = new Date(`${day}T00:00:00`).toISOString();
  return one<{ n: number }>(app.db, "select count(*) n from runs r join conversations c on c.id = r.lane where r.kind = 'ask' and c.channel = ? and r.created_at > ?", channelOf(id), since)?.n ?? 0;
}

async function botNames() {
  const { larkBotInfo } = await import("../channels/lark-send.ts");
  return (ref: string) => larkBotInfo(ref)?.name ?? null;
}

function describe(app: App, b: Bot) {
  if (b.description) return b.description;
  const spec = b.agent === "assistant" ? null : findAgentSpec(app, b.agent);
  return spec?.description ?? "";
}

/** Every assistant on this node; `viewer` other than the owner sees the same list (who is here), and manages only their own. */
export async function listAssistants(app: App): Promise<Assistant[]> {
  const nameOf = await botNames();
  const out: Assistant[] = [];
  const main = one<{ value: string }>(app.db, "select value from kv where key = 'lark_bot_name'")?.value ?? nameOf("main");
  if (app.config.lark.appId)
    out.push({ id: "main", name: main ?? "主助手", description: "本人的主助手：提问、交代事项、交办任务，通知也从这里发", userId: OWNER, userName: userName(app, OWNER), agent: "assistant", enabled: app.config.lark.enabled, appId: app.config.lark.appId, connected: !!nameOf("main"), dailyRuns: null, todayRuns: todayRuns(app, "main"), ownerOpenId: null });
  for (const b of app.config.lark.bots)
    out.push({ id: b.id, name: b.name ?? nameOf(b.id) ?? b.id, description: describe(app, b), userId: ownerOf(b), userName: userName(app, ownerOf(b)), agent: b.agent, enabled: b.enabled, appId: b.appId, connected: !!nameOf(b.id), dailyRuns: b.dailyRuns ?? null, todayRuns: todayRuns(app, b.id), ownerOpenId: b.ownerOpenId ?? null });
  return out;
}

/** The user an assistant's bot belongs to (the owner for the main bot and bots without one). */
export function assistantOwner(app: App, bot: string): string {
  if (bot === "main") return OWNER;
  const b = app.config.lark.bots.find((x) => x.id === bot);
  return b ? ownerOf(b) : OWNER;
}

/** A turn in this channel would go over the assistant's daily limit: what to tell the sender; null when it may run. */
export function overDailyLimit(app: App, channel: string): string | null {
  if (!channel.startsWith("lark:")) return null;
  const b = app.config.lark.bots.find((x) => x.id === channel.slice(5));
  if (!b?.dailyRuns) return null;
  return todayRuns(app, b.id) >= b.dailyRuns ? `这个助手今天的次数用完了（每天 ${b.dailyRuns} 次），明天再来，或找${ownerOf(b) === OWNER ? "它的主人" : userName(app, ownerOf(b))}调整。` : null;
}

function save(app: App, bots: Bot[]) {
  const next = structuredClone(app.config);
  next.lark.bots = bots;
  saveConfig(next, app.home);
  Object.assign(app.config, next);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
function newId(app: App, name: string, appId: string) {
  const base = slug(name) || `bot-${appId.slice(-6).toLowerCase()}`;
  const taken = new Set(["main", ...app.config.lark.bots.map((b) => b.id)]);
  for (let i = 0; ; i++) {
    const id = i ? `${base}-${i + 1}`.slice(0, 32) : base;
    if (!taken.has(id)) return id;
  }
}

function checkAgent(app: App, agent: string) {
  if (agent !== "assistant" && !findAgentSpec(app, agent)) throw new HttpError(400, `没有名为 ${agent} 的 Agent 档案`);
}
function mine(app: App, userId: string, id: string) {
  const b = app.config.lark.bots.find((x) => x.id === id);
  if (!b) throw new HttpError(404, id === "main" ? "主助手在 设置 → 渠道 里设置" : "没有这个助手");
  if (userId !== OWNER && ownerOf(b) !== userId) throw new HttpError(403, "只能管理自己的助手");
  return b;
}

export type NewAssistant = { name?: string; description?: string; agent?: string; appId: string; appSecret: string; ownerOpenId?: string; brand?: "feishu" | "lark" };

/** A new assistant for `userId`, on a Feishu bot app they give (or just created by scan). Its bot connects at once. */
export async function createAssistant(app: App, userId: string, input: NewAssistant): Promise<Assistant> {
  if (!/^cli_[A-Za-z0-9]+$/.test(input.appId)) throw new HttpError(400, "App ID 形如 cli_xxx");
  if (!input.appSecret.trim()) throw new HttpError(400, "需要这个应用的 App Secret");
  if (input.appId === app.config.lark.appId || app.config.lark.bots.some((b) => b.appId === input.appId)) throw new HttpError(409, "这个飞书应用已经绑定在一个助手上");
  const agent = input.agent || "assistant";
  checkAgent(app, agent);
  const { checkLarkApp, saveLarkSecret } = await import("../channels/lark-setup.ts");
  // The secret is checked against Feishu before anything is saved; its bot name is the default name.
  const check = await checkLarkApp(input.appId, input.appSecret.trim()).catch((e) => {
    throw new HttpError(400, `飞书不认这组 App ID 和 Secret：${(e as Error).message.slice(0, 160)}`);
  });
  saveLarkSecret(app.home, { appId: input.appId, appSecret: input.appSecret.trim(), ownerOpenId: input.ownerOpenId, brand: input.brand, name: check?.botName });
  const id = newId(app, input.name || check?.botName || "", input.appId);
  const bot: Bot = {
    id, appId: input.appId, agent, enabled: true,
    ...(input.ownerOpenId ? { ownerOpenId: input.ownerOpenId } : {}),
    ...(userId !== OWNER ? { userId } : {}),
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
  };
  save(app, [...app.config.lark.bots, bot]);
  if (app.config.lark.enabled) {
    const { startLarkBot } = await import("../channels/lark-bot.ts");
    await startLarkBot(app, id).catch((e) => console.warn(`[omem] 助手 ${id} 的机器人没有连上：`, (e as Error).message));
  }
  return (await listAssistants(app)).find((a) => a.id === id)!;
}

/** Change an assistant: its owner may change what it is; only the node's owner sets the daily limit. */
export async function updateAssistant(app: App, userId: string, id: string, patch: { name?: string; description?: string; agent?: string; enabled?: boolean; dailyRuns?: number | null; ownerOpenId?: string }) {
  const b = mine(app, userId, id);
  if (patch.agent !== undefined) checkAgent(app, patch.agent);
  if (patch.dailyRuns !== undefined && userId !== OWNER) throw new HttpError(403, "每天的次数由这台 omem 的主人设置");
  const next: Bot = {
    ...b,
    ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.ownerOpenId !== undefined ? { ownerOpenId: patch.ownerOpenId.trim() || undefined } : {}),
    ...(patch.name !== undefined ? { name: patch.name.trim() || undefined } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() || undefined } : {}),
    ...(patch.dailyRuns !== undefined ? { dailyRuns: patch.dailyRuns ?? undefined } : {}),
  };
  save(app, app.config.lark.bots.map((x) => (x.id === id ? next : x)));
  if (patch.enabled && !b.enabled && app.config.lark.enabled) {
    const { startLarkBot } = await import("../channels/lark-bot.ts");
    await startLarkBot(app, id).catch((e) => console.warn(`[omem] 助手 ${id} 的机器人没有连上：`, (e as Error).message));
  }
  return (await listAssistants(app)).find((a) => a.id === id)!;
}

/** Remove an assistant; its conversations stay. Its bot stops answering at the next restart. */
export function removeAssistant(app: App, userId: string, id: string) {
  mine(app, userId, id);
  save(app, app.config.lark.bots.filter((x) => x.id !== id));
  return { ok: true };
}

/**
 * A new assistant on a bot app created by scanning in Feishu (the registration flow `omem setup`
 * uses, lark-setup.ts): resolves with the link to open at once; when the person has confirmed there,
 * the app is bound as their assistant and they are told what it still lacks.
 */
export async function scanNewAssistant(app: App, userId: string, input: { name?: string; description?: string; agent?: string }): Promise<{ url: string; expiresInMinutes: number } | { error: string }> {
  const agent = input.agent || "assistant";
  checkAgent(app, agent);
  const { registerLarkBot } = await import("../channels/lark-setup.ts");
  const { notify } = await import("../core/notify.ts");
  return await new Promise((resolve) => {
    registerLarkBot({ name: input.name?.trim() || undefined, onQr: (url, expires) => resolve({ url, expiresInMinutes: Math.round(expires / 60) }) })
      .then(async (creds) => {
        const a = await createAssistant(app, userId, { ...input, agent, appId: creds.appId, appSecret: creds.appSecret, ownerOpenId: creds.ownerOpenId, brand: creds.brand });
        notify(app, { title: `助手「${a.name}」已建好`, body: `飞书机器人 ${creds.appId} 已绑定${a.connected ? "并连上" : "，还没连上（看设置 → 渠道 → 机器人权限与事件）"}。在飞书里搜它的名字，私聊它试试。`, userId, link: "#/account" });
      })
      .catch((e) => {
        const error = (e as Error).message;
        resolve({ error });
        // Past the link: the person no longer has the page's answer to look at.
        notify(app, { title: "助手没有建成", body: error.slice(0, 300), userId, link: "#/account" });
      });
  });
}
