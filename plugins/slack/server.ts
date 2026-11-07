import type { PlatformDoc, PluginApi, PluginConnection } from "../../src/plugins/types.ts";

/**
 * Slack (docs/v2/connectors.md): a channel's messages of one day as a chat source, threads under the
 * message they answer, people by name; a channel is watched by the days that got new messages.
 * Days are counted in this machine's time zone.
 */
type Msg = { ts: string; user?: string; bot_id?: string; username?: string; text: string; reply_count?: number; thread_ts?: string; subtype?: string };

async function slack<T>(c: PluginConnection, method: string, params: Record<string, string | number>): Promise<T> {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const r = await c.fetch(`/${method}?${q}`);
  const body = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as { ok: boolean; error?: string } & T;
  // Slack answers 200 with ok: false.
  if (!body.ok) throw new Error(`Slack ${method}：${body.error ?? `HTTP ${r.status}`}`);
  return body;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayOf = (ts: string) => {
  const d = new Date(Number(ts) * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const clock = (ts: string) => {
  const d = new Date(Number(ts) * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Slack's markup as plain text: <@U1> as the person's name, <url|text> as text (url). */
async function plain(text: string, name: (id: string) => Promise<string>) {
  let out = text;
  for (const m of [...text.matchAll(/<@([A-Z0-9]+)>/g)]) out = out.replace(m[0], `@${await name(m[1])}`);
  return out
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2（$1）")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export default function register(api: PluginApi) {
  api.platform({
    provider: "connect-slack",
    syncMinutes: 30,
    guide: "channel 的 id 是频道 ID（C 开头，频道详情最下面），盯着它会同步有新消息的日子（第一次取最近 7 天）；day 写 频道ID/日期，如 C0123/2026-11-07。只读你在里面的频道。",
    readers: [
      {
        kind: "day",
        label: "频道一天的消息",
        id: "频道 ID/YYYY-MM-DD",
        async read(c, id): Promise<PlatformDoc | null> {
          const [channel, date] = id.trim().split("/");
          if (!channel || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error(`写成 频道ID/YYYY-MM-DD：${id}`);
          const start = new Date(`${date}T00:00:00`).getTime() / 1000;
          const names = new Map<string, string>();
          const name = async (u: string) => {
            if (!names.has(u)) {
              const r = await slack<{ user: { real_name?: string; name: string; profile?: { display_name?: string } } }>(c, "users.info", { user: u }).catch(() => null);
              names.set(u, r?.user.profile?.display_name || r?.user.real_name || r?.user.name || u);
            }
            return names.get(u)!;
          };
          const info = await slack<{ channel: { name?: string } }>(c, "conversations.info", { channel }).catch(() => null);
          const msgs: Msg[] = [];
          let cursor: string | undefined;
          do {
            const r = await slack<{ messages: Msg[]; has_more: boolean; response_metadata?: { next_cursor?: string } }>(c, "conversations.history", { channel, oldest: start, latest: start + 86400, inclusive: 1, limit: 200, ...(cursor ? { cursor } : {}) });
            msgs.push(...r.messages);
            cursor = r.has_more ? r.response_metadata?.next_cursor || undefined : undefined;
          } while (cursor && msgs.length < 2000);
          msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
          const who = async (m: Msg) => (m.user ? await name(m.user) : (m.username ?? (m.bot_id ? "机器人" : "某人")));
          const lines: string[] = [];
          for (const m of msgs) {
            if (m.subtype === "channel_join" || m.subtype === "channel_leave") continue;
            lines.push(`${clock(m.ts)} ${await who(m)}：${await plain(m.text, name)}`);
            if (m.reply_count) {
              const r = await slack<{ messages: Msg[] }>(c, "conversations.replies", { channel, ts: m.ts, limit: 200 });
              for (const x of r.messages.filter((x) => x.ts !== m.ts)) lines.push(`  ↳ ${dayOf(x.ts) === date ? "" : `${dayOf(x.ts)} `}${clock(x.ts)} ${await who(x)}：${await plain(x.text, name)}`);
            }
          }
          if (!lines.length) return null;
          return { title: `#${info?.channel.name ?? channel} · ${date}`, text: lines.join("\n"), kind: "chat", updatedAt: new Date(Number(msgs.at(-1)!.ts) * 1000).toISOString() };
        },
      },
      {
        kind: "channel",
        label: "频道",
        id: "频道 ID",
        async changes(c, id, cursor) {
          const channel = id.trim();
          const oldest = cursor ?? String(Date.now() / 1000 - 7 * 86400);
          const msgs: Msg[] = [];
          let next: string | undefined;
          do {
            const r = await slack<{ messages: Msg[]; has_more: boolean; response_metadata?: { next_cursor?: string } }>(c, "conversations.history", { channel, oldest, limit: 200, ...(next ? { cursor: next } : {}) });
            msgs.push(...r.messages);
            next = r.has_more ? r.response_metadata?.next_cursor || undefined : undefined;
          } while (next && msgs.length < 5000);
          const days = [...new Set(msgs.sort((a, b) => Number(a.ts) - Number(b.ts)).map((m) => dayOf(m.ts)))];
          const latest = msgs.at(-1)?.ts ?? cursor;
          return { items: days.map((d) => ({ kind: "day", id: `${channel}/${d}` })), cursor: latest ?? null };
        },
      },
    ],
  });
}
