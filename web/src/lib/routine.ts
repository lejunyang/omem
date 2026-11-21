/**
 * The routine look at a member's own lines (`GET /api/work/routine`, src/items/member-routine.ts): off
 * by default; when on it runs on the member's own AI account, and only when they are logged in to one
 * here on a machine that keeps their runs apart. Pure: the sentence beside the switch.
 */
export type Routine = { on: boolean; ready: boolean; reason: string | null; skippedAt?: string | null };

/** `name`: someone else's (the members list); without it the sentence is to the person themselves. */
export function routineText(r: Routine, name?: string) {
  const whose = name ? `${name}自己` : "你自己";
  if (!r.on) return `打开后每晚的整理用${whose}的 AI 账号跑`;
  if (r.ready) return `开着，用${whose}的 AI 账号跑`;
  return `开着，但现在不会跑：${r.reason ?? "没有可用的 AI 账号"}`;
}
