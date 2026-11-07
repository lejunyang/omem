import type { PlatformDoc, PluginApi, PluginConnection } from "../../src/plugins/types.ts";

/**
 * Google (docs/v2/connectors.md): Drive documents exported as text (Docs as Markdown, Sheets as CSV,
 * Slides as text), Gmail threads, Calendar events. Each product is its own connection (Google Drive,
 * Gmail, Google Calendar in the catalog), so each gets its own pack entry here.
 */
async function call(c: PluginConnection, path: string): Promise<Response> {
  const r = await c.fetch(path);
  if (!r.ok) throw Object.assign(new Error(`Google ${path.split("?")[0]}：HTTP ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
  return r;
}
const json = async <T>(c: PluginConnection, path: string) => (await (await call(c, path)).json()) as T;

type DriveFile = { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string };
const FOLDER = "application/vnd.google-apps.folder";
const EXPORTS: Record<string, string[]> = {
  "application/vnd.google-apps.document": ["text/markdown", "text/plain"],
  "application/vnd.google-apps.spreadsheet": ["text/csv"],
  "application/vnd.google-apps.presentation": ["text/plain"],
};
const MAX_TEXT = 2_000_000;

/** A Drive id from an id or a link (…/d/<id>/…, ?id=<id>, …/folders/<id>). */
export const driveId = (id: string) => /\/(?:d|folders)\/([\w-]{10,})/.exec(id)?.[1] ?? /[?&]id=([\w-]{10,})/.exec(id)?.[1] ?? id.trim();

// ---- Gmail -----------------------------------------------------------------------

type Part = { mimeType: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
type Message = { id: string; internalDate: string; payload: Part };
const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
/** The readable body of a message: its text/plain part, else its HTML as Markdown. */
export function mailBody(p: Part, html: (h: string) => string): string {
  const find = (x: Part, type: string): string | null => {
    if (x.mimeType === type && x.body?.data) return b64url(x.body.data);
    for (const c of x.parts ?? []) {
      const f = find(c, type);
      if (f) return f;
    }
    return null;
  };
  const plain = find(p, "text/plain");
  if (plain) return plain.trim();
  const h = find(p, "text/html");
  return h ? html(h) : "";
}
const header = (p: Part, name: string) => p.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";

// ---- Calendar ----------------------------------------------------------------------

type Event = { id: string; summary?: string; description?: string; location?: string; htmlLink: string; updated: string; status: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; organizer?: { email?: string; displayName?: string }; attendees?: { email?: string; displayName?: string; responseStatus?: string }[] };
const when = (t: { dateTime?: string; date?: string }) => (t.dateTime ?? t.date ?? "").slice(0, 16).replace("T", " ");

export default function register(api: PluginApi) {
  api.platform({
    provider: "connect-google-drive",
    features: [{ id: "drive", label: "读云盘", description: "读你云盘里的文档、表格、幻灯片和文本文件", scopes: ["https://www.googleapis.com/auth/drive.readonly"] }],
    syncMinutes: 60,
    guide: "file、folder 的 id 是链接里 /d/ 或 /folders/ 后面那段（直接给链接也行）。盯着文件夹会同步它和三层以内子文件夹里改过的文档。PDF、图片等读不了。",
    readers: [
      {
        kind: "file",
        label: "文件",
        id: "文件 id 或链接",
        async read(c, id): Promise<PlatformDoc | null> {
          const fid = driveId(id);
          const f = await json<DriveFile>(c, `/drive/v3/files/${fid}?fields=id,name,mimeType,modifiedTime,webViewLink&supportsAllDrives=true`);
          let text: string | null = null;
          for (const type of EXPORTS[f.mimeType] ?? []) {
            try {
              text = await (await call(c, `/drive/v3/files/${fid}/export?mimeType=${encodeURIComponent(type)}`)).text();
              break;
            } catch (e) {
              if ((e as { status?: number }).status !== 400) throw e;
            }
          }
          if (text === null && /^text\/|json|xml|markdown|csv/.test(f.mimeType)) text = await (await call(c, `/drive/v3/files/${fid}?alt=media&supportsAllDrives=true`)).text();
          if (text === null) return null;
          return { id: fid, title: f.name, text: text.slice(0, MAX_TEXT), url: f.webViewLink, updatedAt: f.modifiedTime };
        },
      },
      {
        kind: "folder",
        label: "文件夹",
        id: "文件夹 id 或链接",
        async changes(c, id, cursor) {
          const files: DriveFile[] = [];
          const walk = async (folder: string, depth: number) => {
            let token: string | undefined;
            do {
              const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
              const r = await json<{ files: DriveFile[]; nextPageToken?: string }>(c, `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime),nextPageToken&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${token ? `&pageToken=${token}` : ""}`);
              for (const f of r.files) {
                if (f.mimeType === FOLDER) {
                  if (depth < 3) await walk(f.id, depth + 1);
                } else if (!cursor || f.modifiedTime > cursor) files.push(f);
              }
              token = r.nextPageToken;
            } while (token);
          };
          await walk(driveId(id), 0);
          files.sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime));
          return { items: files.map((f) => ({ kind: "file", id: f.id, cursor: f.modifiedTime })), cursor: files.at(-1)?.modifiedTime ?? cursor };
        },
      },
    ],
  });

  api.platform({
    provider: "connect-google-mail",
    features: [{ id: "mail", label: "读邮件", description: "读你的 Gmail 邮件（只读）", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] }],
    syncMinutes: 30,
    guide: "thread 的 id 是 Gmail 会话 id（网页地址末尾那段）；query 写 Gmail 的搜索语法，如 from:boss@example.com label:inbox，盯着它会同步新来的邮件（第一次只取最近 30 天）。",
    readers: [
      {
        kind: "thread",
        label: "邮件会话",
        id: "Gmail 会话 id",
        async read(c, id): Promise<PlatformDoc | null> {
          const t = await json<{ id: string; messages: Message[] }>(c, `/gmail/v1/users/me/threads/${encodeURIComponent(id.trim())}?format=full`);
          if (!t.messages?.length) return null;
          const parts = t.messages.map((m) => {
            const p = m.payload;
            const head = [`### ${header(p, "from")} · ${new Date(Number(m.internalDate)).toISOString().slice(0, 16).replace("T", " ")}`, header(p, "to") && `收件人：${header(p, "to")}`, header(p, "cc") && `抄送：${header(p, "cc")}`].filter(Boolean).join("\n");
            return `${head}\n\n${mailBody(p, api.text.html)}`;
          });
          const last = t.messages.at(-1)!;
          return { title: header(t.messages[0].payload, "subject") || "（无主题）", text: parts.join("\n\n"), url: `https://mail.google.com/mail/u/0/#all/${t.id}`, updatedAt: new Date(Number(last.internalDate)).toISOString() };
        },
      },
      {
        kind: "query",
        label: "搜索条件",
        id: "Gmail 搜索语法",
        async changes(c, id, cursor) {
          const started = Math.floor(Date.now() / 1000);
          const q = `${id} ${cursor ? `after:${cursor}` : "newer_than:30d"}`;
          const threads: string[] = [];
          let token: string | undefined;
          do {
            const r = await json<{ threads?: { id: string }[]; nextPageToken?: string }>(c, `/gmail/v1/users/me/threads?q=${encodeURIComponent(q)}&maxResults=100${token ? `&pageToken=${token}` : ""}`);
            threads.push(...(r.threads ?? []).map((t) => t.id));
            token = threads.length < 300 ? r.nextPageToken : undefined;
          } while (token);
          return { items: threads.reverse().map((t) => ({ kind: "thread", id: t })), cursor: String(started) };
        },
      },
    ],
  });

  api.platform({
    provider: "connect-google-calendar",
    features: [{ id: "calendar", label: "读日历", description: "读你的 Google 日历（只读）", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }],
    syncMinutes: 60,
    guide: "calendar 的 id 写 primary（你的主日历）或日历设置里的日历 ID，盯着它会同步改过的日程（第一次取前后 30 天）；event 写 日历 id/日程 id。",
    readers: [
      {
        kind: "event",
        label: "日程",
        id: "日历 id/日程 id",
        async read(c, id): Promise<PlatformDoc | null> {
          const i = id.lastIndexOf("/");
          const [cal, ev] = i > 0 ? [id.slice(0, i), id.slice(i + 1)] : ["primary", id];
          const e = await json<Event>(c, `/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(ev)}`);
          if (e.status === "cancelled") return null;
          const lines = [
            `- 时间：${when(e.start)} – ${when(e.end)}`,
            e.location ? `- 地点：${e.location}` : "",
            e.organizer ? `- 组织者：${e.organizer.displayName ?? e.organizer.email}` : "",
            e.attendees?.length ? `- 参加：${e.attendees.map((a) => `${a.displayName ?? a.email}${a.responseStatus === "accepted" ? "" : `（${a.responseStatus}）`}`).join("、")}` : "",
          ].filter(Boolean);
          const desc = e.description ? (/<[a-z][\s\S]*>/i.test(e.description) ? api.text.html(e.description) : e.description.trim()) : "";
          return { title: e.summary ?? "（无标题日程）", text: [lines.join("\n"), desc].filter(Boolean).join("\n\n"), url: e.htmlLink, updatedAt: e.updated };
        },
      },
      {
        kind: "calendar",
        label: "日历",
        id: "primary 或日历 ID",
        async changes(c, id, cursor) {
          const cal = encodeURIComponent(id.trim() || "primary");
          const range = cursor ? `updatedMin=${encodeURIComponent(cursor)}` : `timeMin=${encodeURIComponent(new Date(Date.now() - 30 * 86400_000).toISOString())}&timeMax=${encodeURIComponent(new Date(Date.now() + 30 * 86400_000).toISOString())}`;
          const events: Event[] = [];
          let token: string | undefined;
          do {
            const r = await json<{ items: Event[]; nextPageToken?: string }>(c, `/calendar/v3/calendars/${cal}/events?singleEvents=true&showDeleted=false&maxResults=250&${range}${token ? `&pageToken=${token}` : ""}`);
            events.push(...r.items);
            token = events.length < 1000 ? r.nextPageToken : undefined;
          } while (token);
          const list = events.filter((e) => !cursor || e.updated > cursor).sort((a, b) => a.updated.localeCompare(b.updated));
          return { items: list.map((e) => ({ kind: "event", id: `${id.trim() || "primary"}/${e.id}`, cursor: e.updated })), cursor: list.at(-1)?.updated ?? cursor };
        },
      },
    ],
  });
}
