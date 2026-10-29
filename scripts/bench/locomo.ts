/**
 * LoCoMo → LongMemEval's question shape: every question of a conversation gets that conversation's
 * sessions as its history (session ids `<sample>-s<n>`), and its evidence turns (`D3:7`) become
 * `answer_session_ids`. Category numbers become types (1 multi-hop, 2 temporal, 3 open-domain,
 * 4 single-hop, 5 adversarial — the LoCoMo paper's numbering in the released file).
 */
export function locomoToLongMemEval(samples: any[]) {
  const CATEGORY: Record<string, string> = { "1": "multi-hop", "2": "temporal", "3": "open-domain", "4": "single-hop", "5": "adversarial" };
  const out: unknown[] = [];
  for (const s of samples) {
    const conv = s.conversation ?? {};
    const sessions = Object.keys(conv)
      .map((k) => /^session_(\d+)$/.exec(k)?.[1])
      .filter((n): n is string => !!n && Array.isArray(conv[`session_${n}`]))
      .sort((a, b) => Number(a) - Number(b));
    const sid = (n: string) => `${s.sample_id}-s${n}`;
    const haystack = sessions.map((n) => (conv[`session_${n}`] as any[]).map((t) => ({ role: String(t.speaker ?? "?"), content: [t.text, t.blip_caption ? `[图片：${t.blip_caption}]` : ""].filter(Boolean).join(" ") })));
    (s.qa ?? []).forEach((qa: any, i: number) => {
      const evidence: string[] = (Array.isArray(qa.evidence) ? qa.evidence : []).flatMap((e: string) => String(e).split(/[;,\s]+/));
      const ids = [...new Set(evidence.map((e) => /^D(\d+):/.exec(e)?.[1]).filter((n): n is string => !!n && sessions.includes(n)).map(sid))];
      out.push({
        question_id: `${s.sample_id}-q${i + 1}${String(qa.category) === "5" ? "_abs" : ""}`,
        question_type: CATEGORY[String(qa.category)] ?? `category-${qa.category}`,
        question: String(qa.question ?? ""),
        question_date: String(conv[`session_${sessions.at(-1)}_date_time`] ?? ""),
        answer: String(qa.answer ?? qa.adversarial_answer ?? ""),
        // One space per conversation, shared by its questions (eval-longmemeval.ts).
        haystack_key: String(s.sample_id),
        haystack_session_ids: sessions.map(sid),
        haystack_dates: sessions.map((n) => String(conv[`session_${n}_date_time`] ?? "")),
        haystack_sessions: haystack,
        answer_session_ids: ids,
      });
    });
  }
  return out;
}
