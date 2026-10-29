import type { App } from "../core/app.ts";
import type { Rule } from "./types.ts";

/**
 * What a rule needs from Feishu, checked right after it is saved: the permissions of the owner's
 * lark-cli app and login, and of every omem bot the rule uses. Each gap comes with where to fix it —
 * the developer console page that applies for the permission, or a login link the owner confirms.
 * Some things cannot be read from outside (the data range of a permission, the meeting's own
 * settings, an event subscription that has not been tried yet): those are listed as notes.
 */
export type PermissionIssue = { who: string; problem: string; scopes?: string[]; link?: string; linkText?: string };
export type PermissionReport = { issues: PermissionIssue[]; notes: string[]; ok: string[] };

/** lark-cli (the owner's identity): knowing the owner joined a meeting and reading what is said there. */
const CLI_USER_SCOPES = ["vc:meeting.meetingevent:read"];
const CLI_EVENTS = ["vc.meeting.participant_meeting_joined_v1", "vc.meeting.participant_meeting_ended_v1"];

export async function rulePermissions(app: App, rule: Pick<Rule, "trigger" | "actions" | "enabled">): Promise<PermissionReport> {
  const out: PermissionReport = { issues: [], notes: [], ok: [] };
  if (rule.trigger.event !== "meeting") return out;
  await checkCli(app, out);
  const bots = new Map<string, { answer: boolean }>();
  for (const a of rule.actions) if (a.type === "meeting-bot") for (const b of a.bots) bots.set(b, { answer: (bots.get(b)?.answer ?? false) || a.answer });
  for (const [ref, need] of bots) await checkBot(app, ref, need.answer, out);
  if (bots.size) out.notes.push("想在会议里自己把机器人拉进来：机器人的应用要在“事件与回调”里订阅“机器人被邀请入会”（vc.bot.meeting_invited_v1，长连接接收）。你邀请的直接入会，别人邀请的先发卡片问你；会议设置同下。");
  if (bots.size) {
    out.notes.push("应用的会议权限还要配“权限可访问的数据范围”：开发者后台 → 权限管理 → 数据范围，选“按条件筛选”，条件“会议的归属者 包含 与应用的可用范围一致”；配完重新发布版本。omem 读不到这一项。");
    out.notes.push("会议本身要允许机器人进：多人视频会议、开着 AI 纪要、安全设置里打开“允许智能体加入”；有密码、等候室或只许特定人入会时机器人会被拦下。");
  }
  return out;
}

async function checkCli(app: App, out: PermissionReport) {
  const { larkCli } = await import("../channels/lark-cli.ts");
  const { larkCliState, larkScopeLink, larkEventLink } = await import("../channels/lark-setup.ts");
  const state = await larkCliState();
  if (!state.appId) {
    out.issues.push({ who: "lark-cli", problem: "lark-cli 还没有配置应用：运行 omem setup → 渠道 → 飞书个人采集，或在运行 omem 的电脑上执行 lark-cli config init" });
    return;
  }
  if (!state.user?.ok) {
    out.issues.push({ who: "lark-cli", problem: `lark-cli 还没有以你的身份登录（${state.user?.message ?? "未登录"}）：在运行 omem 的电脑上执行 lark-cli auth login` });
    return;
  }
  // The app must offer the permission before the owner's login can be granted it.
  let enabled: Set<string> | null = null;
  try {
    const v = (await larkCli(["auth", "scopes"], 30_000)) as { userScopes?: string[] };
    if (Array.isArray(v.userScopes)) enabled = new Set(v.userScopes);
  } catch {}
  const offMissing = enabled ? CLI_USER_SCOPES.filter((s) => !enabled!.has(s)) : [];
  if (offMissing.length) {
    out.issues.push({ who: `lark-cli 的应用（${state.appId}）`, problem: "应用没有开通会议事件权限（用户身份）", scopes: offMissing, link: larkScopeLink(state.appId, offMissing, state.brand, "user"), linkText: "去开发者后台开通" });
  } else {
    const { userScopes, requestUserScopes } = await import("../channels/lark-auth.ts");
    const have = await userScopes(true);
    const missing = have ? CLI_USER_SCOPES.filter((s) => !have.has(s)) : [];
    if (missing.length) {
      let link: string | undefined;
      try {
        link = (await requestUserScopes(app, missing, "会议规则要知道你什么时候入会、读会上说的话，")).url;
      } catch {}
      out.issues.push({ who: "lark-cli（你的登录）", problem: "你的登录还没授权会议事件", scopes: missing, link, linkText: link ? "在飞书里确认授权" : undefined });
    } else if (have) out.ok.push("lark-cli：会议事件权限已授权");
    else out.notes.push("读不到 lark-cli 登录已授权的权限，没法确认会议事件权限。");
  }
  // The events themselves are subscribed in the app's console; whether that is done shows once the stream is up.
  const { meetingWatchStatus } = await import("../channels/lark-meetings.ts");
  const w = meetingWatchStatus();
  const subscribe = `应用要在“事件与回调”里订阅 ${CLI_EVENTS.join("、")}（用户身份事件），并用长连接接收`;
  if (w.listening) out.ok.push("正在接收你入会的事件");
  // The minute poll works: the events only make it quicker, so this is a note, not a gap.
  else if (w.error && w.polling) out.notes.push(`收不到你入会的事件（${w.error}），现在每分钟查一次你所在的会议代替，规则照常工作，最多晚一分钟。要即时：${subscribe}（${larkEventLink(state.appId, state.brand)}）。`);
  else if (w.error)
    out.issues.push({
      who: `lark-cli 的应用（${state.appId}）`,
      problem: `（可选）还收不到你入会的事件：${w.error}。现在每分钟查一次你所在的会议代替，规则照常工作，只是最多晚一分钟；要即时就${subscribe}。`,
      link: larkEventLink(state.appId, state.brand),
      linkText: "去订阅事件",
    });
  else out.notes.push(`规则启用后 omem 开始接收你入会的事件（${subscribe}，${larkEventLink(state.appId, state.brand)}）；没订阅也能用，每分钟查一次你所在的会议代替。启用一两分钟后再检查一次可以确认。`);
}

async function checkBot(app: App, ref: string, answer: boolean, out: PermissionReport) {
  const { larkAppSecret, larkAppScopes, larkScopeLink } = await import("../channels/lark-setup.ts");
  const cfg = app.config.lark;
  const extra = ref === "main" ? null : cfg.bots.find((b) => b.id === ref);
  const appId = ref === "main" ? cfg.appId : extra?.appId;
  const who = ref === "main" ? "主机器人" : `机器人 ${ref}`;
  if (!appId) return void out.issues.push({ who, problem: ref === "main" ? "还没有绑定飞书机器人：omem setup → 渠道 → 飞书机器人" : "lark.bots 里没有这个机器人" });
  if (extra && !extra.enabled) out.issues.push({ who, problem: "这个机器人没有启用" });
  const secret = larkAppSecret(app.home, appId, extra ? `OMEM_LARK_APP_SECRET_${ref.toUpperCase().replace(/-/g, "_")}` : cfg.appSecretEnv);
  if (!secret) return void out.issues.push({ who, problem: `没有 ${appId} 的 App Secret，没法检查权限` });
  const need = ["vc:meeting.bot.join:write", "vc:meeting.meetingevent:read", ...(answer ? ["vc:meeting.message:write"] : [])];
  const have = await larkAppScopes(appId, secret);
  if (!have) return void out.notes.push(`${who}（${appId}）：读不到已开通的权限，请自己确认开通了 ${need.join("、")}。`);
  const missing = need.filter((s) => !have.has(s));
  if (missing.length) out.issues.push({ who: `${who}（${appId}）`, problem: "应用缺少会议权限（应用身份）", scopes: missing, link: larkScopeLink(appId, missing), linkText: "去开发者后台申请" });
  else out.ok.push(`${who}：会议权限已开通`);
}

/** The report as text for the assistant to pass on. */
export function permissionText(p: PermissionReport) {
  return [
    p.issues.length ? `权限检查：还缺 ${p.issues.length} 项` : "权限检查：需要的权限都在",
    ...p.issues.map((i) => `- ${i.who}：${i.problem}${i.scopes?.length ? `（${i.scopes.join("、")}）` : ""}${i.link ? ` ${i.linkText ?? "链接"}：${i.link}` : ""}`),
    ...p.notes.map((n) => `- 注意：${n}`),
  ].join("\n");
}
