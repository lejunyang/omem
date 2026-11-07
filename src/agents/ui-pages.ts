import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, newId, now } from "../core/util.ts";

/**
 * Interactive pages (docs/v2/interactive-ui.md, “交互页”): a single HTML file an agent writes — a
 * clickable prototype, a few ways to compare, a small simulation — shown in a sandboxed frame next
 * to its reply or question. Each `ui_page` call with the same id adds a version.
 *
 * The page runs with an opaque origin (`sandbox="allow-scripts"` on a srcdoc frame) and a policy that
 * allows nothing from the network: what it shows must be inside the file (inline scripts, styles,
 * data: images). It cannot read omem's cookies, call omem's API or send what it shows anywhere. It
 * talks to the page around it only through the bridge below (`window.omem`): theme, height, a draft,
 * and — when it is part of a question — the answer.
 */
export const PAGE_MAX = 300_000;

export type UiPage = { id: string; version: number; versions: number[]; title: string; html: string; runId: string | null; conversationId: string | null; createdAt: string };
type Row = { id: string; version: number; run_id: string | null; conversation_id: string | null; user_id: string; title: string; html: string; created_at: string };

export function savePage(app: App, input: { pageId?: string; title: string; html: string; runId: string | null; conversationId: string | null; userId: string }) {
  if (input.html.length > PAGE_MAX) throw new HttpError(400, `页面太大（${input.html.length} 字符，最多 ${PAGE_MAX}）：把数据精简一下，图片用小的 data: 图`);
  if (!input.html.trim()) throw new HttpError(400, "页面是空的");
  let id = input.pageId;
  let version = 1;
  if (id) {
    const last = one<{ user_id: string; version: number }>(app.db, "select user_id, max(version) version from ui_pages where id = ?", id);
    if (!last?.version) throw new HttpError(404, `没有交互页 ${id}：新建时不给 page_id`);
    if (last.user_id !== input.userId) throw new HttpError(403, `交互页 ${id} 不是这个人的`);
    version = last.version + 1;
  } else id = newId("pg");
  run(app.db, "insert into ui_pages(id,version,run_id,conversation_id,user_id,title,html,created_at) values(?,?,?,?,?,?,?,?)", id, version, input.runId, input.conversationId, input.userId, input.title, input.html, now());
  return { id, version };
}

/** A page (its latest version unless one is named), for its owner. */
export function getPage(app: App, id: string, userId: string, version?: number): UiPage {
  const versions = all<{ version: number }>(app.db, "select version from ui_pages where id = ? and user_id = ? order by version", id, userId).map((r) => r.version);
  if (!versions.length) throw new HttpError(404, `没有交互页 ${id}`);
  const v = version && versions.includes(version) ? version : versions.at(-1)!;
  const r = one<Row>(app.db, "select * from ui_pages where id = ? and version = ?", id, v)!;
  return { id, version: v, versions, title: r.title, html: r.html, runId: r.run_id, conversationId: r.conversation_id, createdAt: r.created_at };
}

export function pageTitle(app: App, id: string) {
  return one<{ title: string }>(app.db, "select title from ui_pages where id = ? order by version desc limit 1", id)?.title ?? null;
}

/** Nothing from the network: scripts, styles, images and fonts only inline or as data:/blob:. */
export const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src blob:";

/** The page's own look before the theme arrives: omem's light tokens, plain controls. */
const BASE_CSS = `:root{--bg:#f6f5f2;--panel:#fff;--ink:#1d1d1f;--ink-2:#3a3a3c;--muted:#6e6e73;--line:#e6e3dc;--line-strong:#cfcac0;--accent:#2f5bd3;--danger:#c62828;--ok:#2e7d32;--warn:#b26a00;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;--serif:"Source Han Serif SC","Noto Serif CJK SC","Songti SC",Georgia,serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
html,body{margin:0;background:transparent;color:var(--ink);font:14px/1.6 var(--sans)}
body{padding:12px}
*{box-sizing:border-box}
button{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line-strong);border-radius:8px;padding:5px 12px;cursor:pointer}
button:hover{border-color:var(--ink-2)}
button.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
input,select,textarea{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line-strong);border-radius:8px;padding:5px 8px;max-width:100%}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
img,svg,canvas,video{max-width:100%}`;

/**
 * `window.omem` in the page: `onTheme(fn)`, `onInit(fn)` (draft, whether it can answer, the answer
 * given), `submit(value, summary?)` → Promise, `draft(value)`, `open("#/…")`. The height is reported
 * on its own. Messages go to the parent only and are tagged `omemUi: 1`.
 */
const BRIDGE = `(()=>{const P=parent,S=(m)=>P.postMessage(Object.assign({omemUi:1},m),"*"),T=[],I=[],W=new Map;let n=0,init=null;
const o=window.omem={onTheme(f){T.push(f)},onInit(f){I.push(f);if(init)try{f(init)}catch(e){}},
submit(value,summary){const id=++n;S({type:"submit",id,value,summary:summary==null?undefined:String(summary)});return new Promise((ok,no)=>W.set(id,{ok,no}))},
draft(value){S({type:"draft",value})},open(link){S({type:"open",link:String(link)})}};
addEventListener("message",e=>{if(e.source!==P)return;const d=e.data;if(!d||d.omemUi!==1)return;
if(d.type==="theme"){const r=document.documentElement;r.dataset.theme=d.theme;for(const k in d.tokens||{})r.style.setProperty(k,d.tokens[k]);T.forEach(f=>{try{f(d.theme)}catch(e){}})}
if(d.type==="init"){init=d.init;I.forEach(f=>{try{f(init)}catch(e){}})}
if(d.type==="result"){const w=W.get(d.id);if(w){W.delete(d.id);d.ok?w.ok(d.answer):w.no(new Error(d.error||"提交失败"))}}});
const H=()=>S({type:"height",height:Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0))});
addEventListener("load",()=>{H();try{new ResizeObserver(H).observe(document.body||document.documentElement)}catch(e){setInterval(H,500)}});S({type:"ready"})})();`;

/**
 * The document the frame shows: the host's head first (the policy, the base look, the bridge), then
 * whatever the agent wrote. Its own doctype, html, head and body tags merge into ours as browsers do.
 */
export function pageDocument(html: string) {
  const body = html.replace(/^\s*<!doctype[^>]*>/i, "");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style><script>${BRIDGE}</script></head><body>${body}</body></html>`;
}
