import type { App } from "../core/app.ts";
import { allProfiles } from "../core/config.ts";
import { findThread, updateThread } from "../agents/threads.ts";
import { releaseThreadSession } from "../agents/sessions.ts";
import { resolveModelOption } from "../agents/models.ts";
import { buildCard, type CardSpec } from "./lark-send.ts";

/**
 * The /model card: pick backend, model and effort for this Feishu chat/topic
 * without typing command syntax. Changes are stored on the thread, exactly
 * like /model, so they never leak to other chats.
 */
type Probe = { models: string[]; efforts: string[]; error?: string };

function probeOf(app: App, profileId: string): Probe | null {
  const row = app.db.prepare("select value from kv where key = ?").get(`probe:${profileId}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as Probe;
  } catch {
    return null;
  }
}

function activeProfileId(app: App, threadProfile?: string) {
  return threadProfile ?? app.config.agents.default ?? allProfiles(app.config)[0]?.id ?? "";
}

export function modelCard(app: App, threadId: string): Record<string, unknown> {
  const t = findThread(app, threadId);
  if (!t) throw new Error("会话不存在");
  const profiles = allProfiles(app.config);
  const profileId = activeProfileId(app, t.settings.profile);
  const profile = profiles.find((p) => p.id === profileId);
  const probe = probeOf(app, profileId);
  const offeredModels = probe?.models ?? (profile?.model ? [profile.model] : []);
  const offeredEfforts = probe?.efforts.length ? probe.efforts : ["low", "medium", "high"];
  const model = t.settings.model ?? profile?.model ?? "";
  const effort = t.settings.effort ?? profile?.effort ?? "";
  const blocks: CardSpec["blocks"] = [
    {
      markdown: `**当前会话模型**\n后端 **${profile?.name ?? profileId ?? "未配置"}**${model ? ` · 模型 **${model}**` : ""} · 强度 **${effort || "默认"}**\n设置只对这个群/话题生效，不影响其他会话。`,
    },
    {
      form: {
        name: "model",
        fields: [
          {
            type: "select",
            name: "profile",
            options: [{ text: "跟随默认后端", value: "" }, ...profiles.map((p) => ({ text: `${p.id}${p.model ? ` · ${p.model}` : ""}`, value: p.id }))],
          },
          {
            type: "select",
            name: "model",
            placeholder: "模型（也可以在下面直接输入）",
            options: [...offeredModels.map((m) => ({ text: m, value: m })), { text: "（Agent 默认）", value: "" }],
          },
          {
            type: "select",
            name: "effort",
            placeholder: "思考强度",
            options: [...offeredEfforts.map((e) => ({ text: e, value: e })), { text: "（默认）", value: "" }],
          },
          { type: "input", name: "modelText", placeholder: "或直接输入模型名：GPT-Sol-6.1 会匹配 gpt-6.1-sol" },
        ],
        submit: "应用",
        cancel: "取消",
      },
    },
    {
      buttons: [
        { text: "检测模型（启动 Agent 查一次）", value: "model:probe" },
        { text: "恢复默认", value: "model:off" },
      ],
    },
  ];
  const note = probe?.error ?? (!probe ? "还没探测过可选模型：可以先直接输入名字，或点“检测模型”让 omem 启动 Agent 查一次。" : offeredModels.length ? "" : "Agent 没有报出可选模型；直接输入名字试试。");
  if (note) blocks.push({ note });
  return buildCard({ title: "模型设置（仅本群 / 话题生效）", color: "blue", blocks });
}

export type ModelAction = { value?: unknown; formValue?: unknown };

/** Apply a model-card submission or button press; returns the new card and a toast. */
export function applyModelCard(app: App, threadId: string, action: ModelAction): { card: Record<string, unknown>; toast: string; probe?: boolean } {
  const t = findThread(app, threadId);
  if (!t) throw new Error("会话不存在");
  const value = typeof action.value === "string" ? safe(action.value) : (action.value as Record<string, unknown>);
  if (value && (value as { action?: string }).action === "model:off") {
    updateThread(app, threadId, { settings: { model: null, effort: null } });
    releaseThreadSession(threadId);
    return { card: modelCard(app, threadId), toast: "已恢复默认模型" };
  }
  if (value && (value as { action?: string }).action === "model:probe")
    return { card: modelCard(app, threadId), toast: "正在后台检测，完成后重新打开 /model 卡片", probe: true };

  const form = (typeof action.formValue === "string" ? safe(action.formValue) : action.formValue) as
    | { profile?: string; model?: string; effort?: string; modelText?: string }
    | undefined;
  if (!form) throw new Error("卡片数据为空");
  const typed = (form.modelText ?? "").trim();
  const profileId = form.profile || t.settings.profile || activeProfileId(app);
  const probe = probeOf(app, profileId);
  // Normalize free text against offered names; when nothing matches, keep the
  // typed value (the ACP layer will say it is unavailable rather than guessing).
  let model = typed || form.model || "";
  if (typed && probe?.models?.length) model = resolveModelOption(typed, probe.models).value;
  updateThread(app, threadId, {
    settings: {
      profile: form.profile || undefined,
      model: model || null,
      effort: form.effort || null,
    },
  });
  releaseThreadSession(threadId);
  return { card: modelCard(app, threadId), toast: `本会话改用 ${model || "默认模型"} / ${form.effort || "默认强度"}` };
}

function safe(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { action: s };
  }
}
