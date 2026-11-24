import { get } from "../api";

/**
 * 快速通道 on the web (docs/v2/first-look.md): the probe library (预查库, src/rules/probes.ts), the
 * first look's three settings on a rule's agent action and on a 关注, and how a first-look run's stages
 * read. Shared by the rules page, the 关注 pages, the settings card and the runs page.
 */
export type Runtime = "node" | "python" | "bash";
/** A probe as the list has it (GET /api/probes): no code, its line count. */
export type ProbeSummary = { name: string; description: string; match?: string; runtime: Runtime; timeoutSec: number; direct: boolean; createdBy: string; createdAt: string; updatedAt: string; via?: string; lines: number };
/** A probe in full (GET /api/probes/:name), what the editor saves (PUT). */
export type Probe = Omit<ProbeSummary, "lines"> & { code: string };
export type ProbeTry = { matched: boolean; captures: Record<string, string>; ok: boolean; output: string; stderr: string; exitCode: number | null; timedOut: boolean; ms: number; runId: string | null };

export type FirstTo = "chat" | "dm" | "ephemeral";
export type FirstLookOptions = {
  to: FirstTo;
  destinations: { value: FirstTo; label: string; note?: string }[];
  probes: { name: string; description: string; match: string | null; direct: boolean }[];
  budgetSec: number;
  rulePerDay: number;
  probeTimeoutMax: number;
};

export const RUNTIMES: { value: Runtime; label: string }[] = [
  { value: "node", label: "Node" },
  { value: "python", label: "Python" },
  { value: "bash", label: "Bash" },
];
export const RUNTIME_HINT: Record<Runtime, string> = { node: "Node（omem 自己的 Node）", python: "Python 3", bash: "Bash" };

/** What a new probe starts as: reading the message and the regex's captures it gets. */
export const PROBE_SAMPLE: Record<Runtime, string> = {
  node: [
    "// 触发的消息在 OMEM_EVENT（JSON，也从标准输入传进来）；匹配条件的捕获组在 OMEM_CAPTURES。",
    "const event = JSON.parse(process.env.OMEM_EVENT);",
    "const captures = JSON.parse(process.env.OMEM_CAPTURES || \"{}\");",
    "// 只读：查完把结论打印出来，交给后面的“先看一眼”。",
    "console.log(`消息：${event.message?.text ?? \"\"}`);",
    "console.log(`捕获：${captures[\"1\"] ?? \"（没有）\"}`);",
  ].join("\n"),
  python: [
    "# 触发的消息在 OMEM_EVENT（JSON，也从标准输入传进来）；匹配条件的捕获组在 OMEM_CAPTURES。",
    "import json, os",
    "event = json.loads(os.environ[\"OMEM_EVENT\"])",
    "captures = json.loads(os.environ.get(\"OMEM_CAPTURES\") or \"{}\")",
    "# 只读：查完把结论打印出来，交给后面的“先看一眼”。",
    "print(\"消息：\", (event.get(\"message\") or {}).get(\"text\", \"\"))",
    "print(\"捕获：\", captures.get(\"1\", \"（没有）\"))",
  ].join("\n"),
  bash: [
    "# 触发的消息在 $OMEM_EVENT（JSON，也从标准输入传进来）；匹配条件的捕获组在 $OMEM_CAPTURES。",
    "# 只读：查完把结论打印出来，交给后面的“先看一眼”。",
    "echo \"捕获：$OMEM_CAPTURES\"",
  ].join("\n"),
};

/** What each place the first message may go does, and when it goes elsewhere instead (resolveDest). */
export const FIRST_TO_EFFECT: Record<FirstTo, string> = {
  chat: "机器人在触发的消息下回复，群里的人都看得到。只有回复方式是“直接回复”时才真的发到群里；结论要你定、或回复方式是只告诉我 / 先给我看时，改成群里只有你看得到的卡片。",
  dm: "机器人私聊发给你，群里看不到任何东西。",
  ephemeral: "群里一张只有你看得到的卡片，上面有“发给大家”和“不用了”。在私聊里触发、你不在群里或发不出时，改成私聊发给你。",
};

let cached: Promise<FirstLookOptions> | null = null;
/** The defaults and the probe list for the three settings (GET /api/first-look/options); `fresh` after the library changed. */
export function firstLookOptions(fresh = false) {
  if (fresh || !cached) cached = get<FirstLookOptions>("/api/first-look/options").catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}
export function forgetFirstLookOptions() {
  cached = null;
}

/** The three settings, on a rule's agent action and in a 关注's knobs. `firstTo` absent: the setting `firstLook.to`. */
export type FirstLookFields = { firstLook?: boolean; probes?: string[]; firstTo?: FirstTo };

/** One sentence for a rule's summary: “先看一眼（预查 a、b）· 第一条私聊发给我”. */
export function firstLookLine(f: FirstLookFields, defaults?: Pick<FirstLookOptions, "to" | "destinations">) {
  if (!f.firstLook) return f.probes?.length ? `预查 ${f.probes.join("、")}` : "";
  const to = f.firstTo ?? defaults?.to;
  const dest = defaults?.destinations.find((d) => d.value === to)?.label ?? (to ? DEST_SHORT[to] : "");
  return ["先快速看一眼", f.probes?.length ? `预查 ${f.probes.join("、")}` : "", dest ? `第一条${dest}` : ""].filter(Boolean).join(" · ");
}
const DEST_SHORT: Record<FirstTo, string> = { chat: "发到群里", dm: "私聊发给我", ephemeral: "群里只有我看得到" };

// ---- a first-look run's stages (output.stages, src/rules/first-look.ts)
export type ProbeStage = { name: string; ok: boolean; skipped?: string; ms: number; timedOut?: boolean; runId?: string };
export type FirstLookStages = {
  prefilter?: string;
  probes?: { ms: number; results: ProbeStage[] };
  look?: { ms: number; outcome: "answered" | "escalate" | "owner"; by: "model" | "host" | "probe"; reason?: string; ai?: { profile?: string; model?: string; effort?: string } | string };
  decision?: { taken?: string; threshold?: number; probabilities?: Record<string, number>; said?: string; skipped?: string };
  first?: { at?: string; to: FirstTo | "none"; why?: string[] };
  deep?: { runId: string | null; at?: string; detail?: string };
};
export const OUTCOME_TEXT: Record<string, string> = { answered: "答完了", escalate: "要接着查", owner: "要你定" };
export const DEST_TEXT: Record<string, string> = { chat: "发到群里", dm: "私聊发给你", ephemeral: "群里只有你看得到的卡片", none: "没有发" };
/** 830 毫秒 / 4.2 秒 / 1 分 5 秒. */
export function msText(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}
export function aiText(ai: NonNullable<FirstLookStages["look"]>["ai"]) {
  if (!ai) return "";
  if (typeof ai === "string") return ai;
  return [ai.profile, ai.model, ai.effort].filter(Boolean).join(" · ");
}
