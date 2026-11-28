import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { findThread, type ThreadMessage } from "./threads.ts";
import { backendAvailable } from "./availability.ts";
import { accountPolicy, isAiMember, loggedIn, memberAccountPlan, selectedMemberAccount, startLogin } from "./accounts.ts";
import { aiLoginWait, backendLoginReady, waitForBackendLogin } from "./credential-wait.ts";
import { ResumeAfterAiLogin, addRunEvent, setRunOutput } from "./runs.ts";
import { canStartLogin, startCredentialLogin } from "./credentials.ts";
import { credentialKindsForBackend } from "./credential-registry.ts";
import { loginMethodsFor } from "./agent-logins.ts";
import { loginDestination, sendAiLoginCard, sendAiLoginStatus } from "../channels/lark-ai-login.ts";
import { excluded, sourceOf } from "./capacity.ts";
import { notify } from "../core/notify.ts";
import { homeOf } from "./home.ts";

type Options = {
  userId: string;
  runId: string | null;
  threadId?: string;
  messages?: ThreadMessage[];
  pinned?: boolean;
  ownOnly?: boolean;
  waitForLogin?: boolean;
  signal?: AbortSignal;
  alternatives?: AgentProfile[];
  revising?: boolean;
};

export async function selectMemberRunAccount(app: App, raw: AgentProfile, o: Options): Promise<AgentProfile> {
  const { userId, runId } = o;
  if (!isAiMember(app, userId)) return raw;
  o.signal?.throwIfAborted();
  const waiting = aiLoginWait(app, runId);
  const home = !o.messages ? homeOf(app, runId) : null;
  const threadId = waiting?.threadId ?? o.threadId ?? home?.conversationId;
  const thread = threadId ? findThread(app, threadId) ?? undefined : undefined;
  const anchor = o.messages?.findLast(m => m.role === "user" && m.meta.userId === userId && typeof m.meta.externalId === "string");
  const homeAnchor = home?.conversationId === threadId ? home?.anchor ?? undefined : undefined;
  const replyTo = waiting?.replyTo ?? (anchor?.meta.externalId as string | undefined) ?? homeAnchor;
  const inThread = waiting?.inThread ?? (anchor ? !!anchor.meta.larkInThread : !!thread?.key?.includes("#"));
  const senderId = typeof anchor?.meta.larkSenderId === "string" ? anchor.meta.larkSenderId : undefined;
  const where = { userId, thread, replyTo, inThread, senderId };
  const event = (text: string, details: object) => { if (runId) addRunEvent(app, runId, "status", { text, ...details }); };
  if (waiting && !waiting.ready && !loggedIn(app, userId, waiting.backend)) {
    if (Date.parse(waiting.deadline) > Date.now()) throw new ResumeAfterAiLogin(Date.parse(waiting.deadline));
    const text = waiting.name + (o.waitForLogin ? " 登录等待已超时。在工作话题发一条补充即可重新跟进。" : " 登录等待已超时。这次运行已停止，重发请求可以重新登录。");
    event(text, { account: { holder: userId, profile: raw.id, reason: "登录超时" } });
    if (o.waitForLogin && threadId) {
      await (await import("./inbox.ts")).deliverToThread(app, threadId, text, { runId });
    } else if (runId && await sendAiLoginStatus(app, where, text).catch(() => false)) setRunOutput(app, runId, { channelDelivered: true });
    throw new Error(text);
  }
  // Once asked to authorize, the original turn resumes on this member's login even if quota reset meanwhile.
  const plan = memberAccountPlan(app, userId, raw, o.ownOnly || !!waiting, o.waitForLogin);
  if (plan.kind === "ready") {
    const choice = selectedMemberAccount(plan.profile);
    if (choice && o.pinned && choice.ownerPressure && !waiting && !o.revising) {
      const text = raw.name ?? raw.id;
      await sendAiLoginStatus(app, where, text + " 的" + choice.reason + "。").catch(() => {});
    }
    if (waiting && !o.revising) event("成员已完成 " + waiting.name + " 登录，继续原运行", { account: { holder: userId, profile: raw.id, reason: "成员授权完成" } });
    return plan.profile;
  }
  if (waiting) throw new Error("成员登录已不可用，请重发请求");
  if (plan.kind === "login" && runId && !o.revising) {
    const { chatId, recipient } = loginDestination(app, where);
    const entry = plan.entry;
    const credential = credentialKindsForBackend(entry.id).find(m => canStartLogin(app, userId, m));
    const plugin = loginMethodsFor(entry.id)[0];
    const native = entry.account.login;
    const canSendCard = (chatId || recipient) && (credential || plugin || (native && !native.input));
    if (canSendCard || o.waitForLogin) {
      const timeout = credential || plugin ? 660_000 : native?.timeoutMs ?? 600_000;
      const deadline = Date.now() + timeout + 60_000;
      waitForBackendLogin(app, runId, { userId, backend: entry.id, name: entry.name, pick: { profile: raw.id, model: raw.model, effort: raw.effort }, deadline: new Date(deadline).toISOString(), threadId, replyTo, inThread });
      event(plan.reason, { account: { holder: userId, profile: raw.id, reason: plan.reason, waiting: true, pinned: !!o.pinned } });
      const askOnAccountPage = async () => {
        const text = "请在账号页的「我的 AI 账号」登录 " + entry.name + "，完成后会继续这次运行。";
        notify(app, { userId, title: "等待登录 " + entry.name, body: text, link: "#/account", runId });
        if (threadId) await (await import("./inbox.ts")).deliverToThread(app, threadId, text, { runId });
      };
      if (canSendCard) {
        try {
          const reply = credential ? await startCredentialLogin(app, userId, credential.kind, undefined, false)
            : await startLogin(app, userId, entry.id, plugin?.key ?? "native", false);
          o.signal?.throwIfAborted();
          if (reply.done || loggedIn(app, userId, entry.id)) backendLoginReady(app, userId, entry.id);
          else await sendAiLoginCard(app, where, entry.name, plan.reason + "。请用自己的账号授权，完成后这次运行会继续。", reply);
        } catch {
          o.signal?.throwIfAborted();
          if (!o.waitForLogin) throw new Error("无法在飞书发起 " + entry.name + " 登录，请重发请求再试");
          await askOnAccountPage();
        }
      } else await askOnAccountPage();
      throw new ResumeAfterAiLogin(deadline);
    }
  }
  if (!o.pinned && (o.ownOnly || plan.kind === "login" || plan.reason.startsWith("本人额度紧张") || app.config.agents.accountIsolation === "require" || accountPolicy(app, sourceOf(raw)) === "own-or-other")) {
    for (const fallback of o.alternatives ?? []) {
      if (!backendAvailable(fallback, app.home)) continue;
      const next = memberAccountPlan(app, userId, fallback, o.ownOnly);
      if (next.kind === "ready" && !excluded(app, next.profile)) {
        event(plan.reason + "，尝试 " + fallback.id, { account: { profile: raw.id, reason: plan.reason } });
        return next.profile;
      }
    }
  }
  if (plan.kind === "login" && !thread) notify(app, { userId, title: "请登录 " + plan.entry.name, body: plan.reason, link: "#/account" });
  throw new Error(plan.reason);
}
