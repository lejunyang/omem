import type { App } from "./app.ts";
import { one, run } from "./db.ts";

/**
 * Notification lessons: when the owner dismisses ("忽略") a nudge for a class
 * of signals, similar future nudges stop pinging and stay in-app only.
 *
 * A rule is a few coarse keywords extracted from the title/body (Chinese is
 * tokenized by bigrams); a new notification matches when its own keywords
 * overlap the rule strongly enough. Rules are personal preference memories in
 * disguise, kept here so the push gate is synchronous and cheap.
 */
type MuteRule = {
  id: string;
  /** Example title the rule was learned from, shown so the owner can audit it. */
  example: string;
  keywords: string[];
  /** chat id if the lesson applies to one chat ("this group's join requests"); absent = everywhere. */
  chatId?: string;
  createdAt: string;
  /** How many future notifications this rule has suppressed. */
  hits: number;
};

const KEY = "notify_mute_rules";

export function listMuteRules(app: App): MuteRule[] {
  const raw = one<{ value: string }>(app.db, "select value from kv where key = ?", KEY)?.value;
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as MuteRule[]) : [];
  } catch {
    return [];
  }
}

function saveRules(app: App, rules: MuteRule[]) {
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", KEY, JSON.stringify(rules));
}

const STOP = new Set(["我们", "你们", "他们", "已经", "可以", "需要", "一个", "这个", "那个", "通知", "提醒", "请", "的", "了", "和", "与", "及", "在", "是", "我", "你", "他"]);

/** Coarse, stable keywords: latin words/ids and Chinese bigrams, stopwords dropped. */
export function keywords(text: string): string[] {
  const out = new Set<string>();
  const cleaned = text.replace(/https?\S+|[A-Za-z]*\d{3,}[A-Za-z0-9-]*/g, " ").toLowerCase();
  for (const m of cleaned.matchAll(/[a-z][a-z-]{2,}/g)) {
    if (!STOP.has(m[0])) out.add(m[0]);
  }
  const cjk = cleaned.replace(/[^\u4e00-\u9fff]+/g, " ");
  for (const part of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= part.length; i++) {
      const g = part.slice(i, i + 2);
      if (!STOP.has(g)) out.add(g);
    }
  }
  return [...out].slice(0, 40);
}

function score(want: Set<string>, have: Set<string>) {
  if (!want.size) return 0;
  let n = 0;
  for (const k of want) if (have.has(k)) n++;
  return n / want.size;
}

export function muteMatch(app: App, n: { title: string; body?: string; sourceRefs?: string[] }, threshold = 0.55): MuteRule | null {
  const have = new Set(keywords(`${n.title} ${n.body ?? ""}`));
  for (const r of listMuteRules(app)) {
    if (r.chatId && !(n.sourceRefs ?? []).some((x) => x.includes(r.chatId!))) continue;
    if (score(new Set(r.keywords), have) >= threshold) return r;
  }
  return null;
}

/** Learn one dismissal. Existing rules accumulate hits; near-duplicate rules merge. */
export function learnMute(app: App, n: { title: string; body?: string; sourceRefs?: string[] }, chatId?: string): MuteRule {
  const rules = listMuteRules(app);
  const kw = keywords(`${n.title} ${n.body ?? ""}`);
  const existing = muteMatch(app, n, 0.7);
  if (existing) return existing;
  const rule: MuteRule = { id: `mr_${Date.now().toString(36)}`, example: n.title, keywords: kw, ...(chatId ? { chatId } : {}), createdAt: new Date().toISOString(), hits: 0 };
  rules.unshift(rule);
  saveRules(app, rules.slice(0, 100));
  return rule;
}

export function recordMuteHit(app: App, id: string) {
  const rules = listMuteRules(app);
  const r = rules.find((x) => x.id === id);
  if (!r) return;
  r.hits++;
  saveRules(app, rules);
}

export function deleteMuteRule(app: App, id: string) {
  saveRules(app, listMuteRules(app).filter((r) => r.id !== id));
}
