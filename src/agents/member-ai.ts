import { z } from "zod";
import type { App } from "../core/app.ts";
import { allProfiles } from "../core/config.ts";
import { findUser, updateUser } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { isAiMember } from "./accounts.ts";
import { backendAvailable } from "./availability.ts";
import { getThread, updateThread, type Thread } from "./threads.ts";

export type MemberAiPick = { profile?: string; model?: string; effort?: string };
export type MemberAi = MemberAiPick & { guidance?: string };

const field = (max: number) => z.string().trim().max(max).optional();
const settingsSchema = z.object({ profile: field(200), model: field(200), effort: field(80), guidance: field(2000) }).strict();

export function memberAi(app: App, userId?: string): MemberAi {
  return userId && isAiMember(app, userId) ? findUser(app, userId)?.settings.memberAi ?? {} : {};
}

export function setMemberAi(app: App, userId: string, patch: unknown): MemberAi {
  if (!isAiMember(app, userId)) throw new HttpError(403, "个人 AI 设置仅供成员使用");
  const result = settingsSchema.safeParse(patch);
  if (!result.success) throw new HttpError(400, "AI 设置格式有误，偏好说明最多 2000 字");
  const next = { ...memberAi(app, userId), ...result.data };
  if (next.profile && result.data.profile !== undefined) {
    const profile = allProfiles(app.config).find(p => p.id === next.profile);
    if (!profile || !backendAvailable(profile, app.home)) throw new HttpError(400, "所选后端不可用：" + next.profile);
  }
  const saved = { profile: next.profile || undefined, model: next.model || undefined, effort: next.effort || undefined, guidance: next.guidance || undefined };
  updateUser(app, userId, { settings: { memberAi: saved } });
  return saved;
}

export function memberThreadAi(app: App, thread: Thread, userId: string): MemberAiPick {
  const local = thread.settings.memberAi?.[userId];
  const personal = memberAi(app, userId);
  const usePersonalModel = !local?.profile || local.profile === personal.profile;
  return {
    profile: local?.profile ?? personal.profile,
    model: local?.model ?? (usePersonalModel ? personal.model : undefined),
    effort: local?.effort ?? (usePersonalModel && !local?.model ? personal.effort : undefined),
  };
}

export function setMemberThreadAi(app: App, threadId: string, userId: string, patch: MemberAiPick) {
  const all = getThread(app, threadId).settings.memberAi ?? {};
  const next = { ...all, [userId]: { ...all[userId], ...patch } };
  if (!Object.values(next[userId]).some(Boolean)) delete next[userId];
  updateThread(app, threadId, { settings: { memberAi: next } });
}
