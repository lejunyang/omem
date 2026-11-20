import type { RunKind } from "../agents/runs.ts";

export const scenes = ["问答", "排查", "编码", "评审", "文档与知识", "会议", "提醒与跟进", "整理（后台）", "其他"] as const;
export type Scene = typeof scenes[number];
/** 固定口径；未知的新类型必须先补这张表。档案和角色只细分通用 Agent 运行。 */
export const sceneTable = {
  ask: "问答", guest: "问答", "peer-agent": "问答", "lark-command": "问答", tutor: "问答",
  agent: "排查", "agent-followup": "排查", "rule-fire": "排查", "rule-script": "排查", "study-trial": "排查", "peer-trial": "排查",
  code: "编码", "req-split": "编码", design: "编码", review: "评审", "speaking-review": "评审", "note-review": "评审",
  brief: "文档与知识", "lark-resource-parse": "文档与知识",
  "commit-claim": "提醒与跟进", "item-follow": "提醒与跟进", heartbeat: "提醒与跟进", wake: "提醒与跟进", mention: "提醒与跟进", "item-settle": "提醒与跟进", "work-state": "提醒与跟进", "flow-stage": "提醒与跟进", "problem-follow": "提醒与跟进",
  archive: "整理（后台）", "archive-rule-draft": "整理（后台）", "thread-summary": "整理（后台）", "learn-feed": "整理（后台）",
  ingest: "整理（后台）", "ingest-shadow": "整理（后台）", "wiki-plan": "整理（后台）", "wiki-write": "整理（后台）", "wiki-lint": "整理（后台）",
  "wiki-organize": "整理（后台）", "wiki-resolve": "整理（后台）", "wiki-migrate": "整理（后台）", "wiki-sweep": "整理（后台）",
  dream: "整理（后台）", sync: "整理（后台）", curate: "整理（后台）", "memory-review": "整理（后台）", "memory-organize": "整理（后台）", "skill-organize": "整理（后台）",
  "role-merge": "整理（后台）", "profile-review": "整理（后台）", "flow-review": "整理（后台）", triage: "整理（后台）", digest: "整理（后台）",
  replay: "整理（后台）", "replay-arm": "整理（后台）", "replay-judge": "整理（后台）", "kb-scout": "整理（后台）", "quality-audit": "整理（后台）", "listen-coach": "整理（后台）", "outcome-review": "整理（后台）",
} satisfies Record<RunKind, Scene>;

export const profileScenes: Record<string, Scene> = {
  "wiki-writer": "文档与知识", writer: "文档与知识", distiller: "文档与知识", summarizer: "文档与知识",
  reviewer: "评审", "review-lead": "评审", coder: "编码", investigator: "排查", "meeting-assistant": "会议",
};
/** Ticks on a timer: counted as use only when they came to something. */
const TICKS = new Set(["heartbeat", "wake", "item-settle", "work-state"]);
export function sceneOf(r: { kind: string; spec?: string | null; roles?: string | null; via?: string | null; quiet?: number | boolean | null }): Scene {
  // A patrol every quarter of an hour that found nothing to say is the system idling, not someone
  // using it: with the upkeep, not in the usage totals. One that reminded or acted stays 提醒与跟进.
  if (r.quiet && TICKS.has(r.kind)) return "整理（后台）";
  if (["agent", "agent-followup", "rule-fire", "rule-script"].includes(r.kind)) {
    if (r.via === "mention") return "提醒与跟进";
    if (r.spec && profileScenes[r.spec]) return profileScenes[r.spec];
    for (const role of (r.roles ?? "").split("|")) if (profileScenes[role]) return profileScenes[role];
  }
  return sceneTable[r.kind as RunKind] ?? "其他";
}
