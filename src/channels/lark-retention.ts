import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json } from "../core/util.ts";
import { larkClient } from "./lark-send.ts";
import { larkCli } from "./lark-cli.ts";
import { mentionIds, type LarkMessage } from "./lark-messages.ts";

export type RetentionState = {
  chatId: string; messageId: string; since: number; detectedAt: number;
  invite: "pending" | "joined" | "approval" | "failed" | "removed";
  attempts: number; retryAt: number; captureAt?: number; captureError?: string;
  inviteError?: string; lifecycle?: "owner-removed" | "bot-removed" | "disbanded";
  botEventAt?: number;
};
const key = (chatId: string) => `lark_retention:${chatId}`;
export function retentionState(app: App, chatId: string) {
  return json<RetentionState | null>(one<{ value: string }>(app.db, "select value from kv where key=?", key(chatId))?.value, null);
}
export function saveRetention(app: App, state: RetentionState) {
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value", key(state.chatId), JSON.stringify(state));
}
export function retentionChats(app: App) {
  return all<{ value: string }>(app.db, "select value from kv where key like 'lark_retention:%'").map(r => json<RetentionState>(r.value, {} as RetentionState));
}
export function retentionRule(app: App, chatId: string) {
  const cfg = app.config.lark.capture.mentionRetention;
  if (!cfg.enabled) return undefined;
  const mapped = cfg.chats.find(c => c.chatId === chatId) ?? json<Mapping | undefined>(one<{ value: string }>(app.db, "select value from kv where key=?", `lark_oncall_map:${chatId}`)?.value, undefined);
  return mapped && cfg.tenantIds.includes(mapped.tenantId) ? mapped : undefined;
}
/** Only structured mentions in the correct application's identity namespace count. */
export function detectRetention(app: App, m: LarkMessage, owner: string | undefined, via: "user" | "bot" = "user") {
  const cfg = app.config.lark.capture.mentionRetention;
  const expected = via === "user" ? cfg.cliOwnerOpenId : app.config.lark.ownerOpenId;
  if (!owner || owner !== expected || !m.chat_id || !retentionRule(app, m.chat_id) || !mentionIds(m).includes(owner)) return false;
  if (!retentionState(app, m.chat_id)) saveRetention(app, {
    chatId: m.chat_id, messageId: m.message_id, since: Number.isFinite(Date.parse(m.create_time)) && !/^\d+$/.test(m.create_time) ? Date.parse(m.create_time) : Number(m.create_time),
    detectedAt: Date.now(), invite: "pending", attempts: 0, retryAt: 0,
  });
  return true;
}

/** Lifecycle events are evidence; ticket-platform archival flags are deliberately not used. */
export function retentionLifecycle(app: App, chatId: string, event: RetentionState["lifecycle"]) {
  const s = retentionState(app, chatId);
  if (!s) return;
  if (s.lifecycle === "disbanded") return;
  s.lifecycle = event;
  if (event === "bot-removed") s.invite = "removed"; // respect removal; never fight an admin
  saveRetention(app, s);
}

// The durable retryAt lease also serializes separate polling/event callbacks and survives restart.
export async function inviteRetentionBot(app: App, chatId: string, owner: string | undefined) {
  const cfg = app.config.lark.capture.mentionRetention;
  const s = retentionState(app, chatId);
  if (!s || !retentionRule(app, chatId) || owner !== cfg.cliOwnerOpenId || !owner || !app.config.lark.appId) return;
  if (s.invite === "pending" && s.attempts >= 3 && s.retryAt <= Date.now()) {
    saveRetention(app, { ...s, invite: "failed", inviteError: s.inviteError ?? "邀请尝试已达上限，请核查成员与审批状态" });
    return;
  }
  if (s.lifecycle === "disbanded" || !["pending", "approval", "joined"].includes(s.invite) || s.retryAt > Date.now() || (s.invite === "pending" && s.attempts >= 3)) return;
  s.retryAt = Date.now() + 10 * 60_000;
  if (s.invite === "pending") s.attempts++;
  saveRetention(app, s);
  try {
    const appId = app.config.lark.appId;
    const member = async () => {
      const r = await larkClient().im.chatMembers.isInChat({ path: { chat_id: chatId } });
      if (r.code || typeof r.data?.is_in_chat !== "boolean") throw new Error(`机器人成员核验失败（${r.code ?? "未知"}）`);
      return r.data.is_in_chat as boolean;
    };
    if (await member()) s.invite = "joined";
    else {
      if (s.invite === "approval") return; // waiting approval never sends another invitation
      if (s.invite === "joined") { s.invite = "removed"; return; }
      const v = await larkCli(["im", "chat.members", "create", "--chat-id", chatId, "--member-id-type", "app_id", "--data", JSON.stringify({ id_list: [appId] }), "--as", "user", "--format", "json"]);
      if (v.data?.pending_approval_id_list?.includes(appId)) s.invite = "approval";
      else if (v.data?.invalid_id_list?.length || v.data?.not_existed_id_list?.length) throw new Error("应用不可邀请（invalid_id_list / not_existed_id_list）");
      else {
        if (!await member()) throw new Error("邀请后未确认机器人成员身份");
        s.invite = "joined";
      }
    }
    s.inviteError = undefined;
  } catch (e) {
    s.inviteError = (e as Error).message.slice(0, 300);
    if (s.invite === "pending" && s.attempts >= 3) s.invite = "failed";
    console.warn(`[omem] 保留群机器人邀请失败 ${chatId}（${s.attempts}/3）`);
  } finally {
    // Events may have arrived while the CLI was in flight. Do not overwrite their state.
    const latest = retentionState(app, chatId)!;
    saveRetention(app, { ...latest, attempts: s.attempts, retryAt: s.retryAt,
    invite: latest.lifecycle === "bot-removed" ? "removed" : s.invite, inviteError: s.inviteError });
  }
}

type Mapping = { chatId: string; tenantId: string; flowId: string; evidence: string; related: boolean };
let oncallOverride: ((args: string[]) => Promise<any>) | null = null;
export function setOncallCliForTests(fn: typeof oncallOverride) { oncallOverride = fn; }
async function oncall(app: App, args: string[]) {
  if (oncallOverride) return oncallOverride(args);
  const executable = app.config.lark.capture.mentionRetention.oncallCli;
  if (!executable || !isAbsolute(executable)) throw new Error("Oncall CLI 必须配置绝对路径");
  try {
    const { stdout } = await promisify(execFile)(executable, ["--no-auto-upgrade", "--json", "oncall", ...args, "--format", "json"], { timeout: 20_000, maxBuffer: 8_000_000 });
    const v = JSON.parse(stdout);
    if (v.status !== "success" || !v.data) throw new Error("Oncall 返回失败或缺少 data");
    return v.data;
  } catch { throw new Error("Oncall 只读查询失败，请检查 CLI 登录、权限和输出版本（未推进发现游标）"); }
}
/** Material from the ticket platform confirms the mapping; names/text never authorize a chat. */
export async function discoverRetentionChats(app: App, chatIds: string[]) {
  const cfg = app.config.lark.capture.mentionRetention;
  if (!cfg.enabled || !cfg.oncallCli || !chatIds.some(id => !retentionRule(app, id))) return;
  const wanted = new Set(chatIds.filter(id => !retentionRule(app, id)));
  type Scan = { tenants: string; tenant: number; page: number; items: Record<string, any>[]; index: number; more: boolean; retryAt: number };
  const signature = JSON.stringify(cfg.tenantIds);
  let scan = json<Scan | undefined>(one<{ value: string }>(app.db, "select value from kv where key='lark_oncall_scan'")?.value, undefined);
  if (!scan || scan.tenants !== signature) scan = { tenants: signature, tenant: 0, page: 1, items: [], index: 0, more: true, retryAt: 0 };
  if (scan.retryAt > Date.now()) return;
  const commit = () => run(app.db, "insert into kv(key,value) values('lark_oncall_scan',?) on conflict(key) do update set value=excluded.value", JSON.stringify(scan));
  let budget = 6;
  const failedMapping = (tenant: string, flowId: string, item: Record<string, any>, error: unknown) => {
    const key = `lark_oncall_failure:${tenant}:${flowId}`;
    const prev = json<{ attempts: number }>(one<{ value: string }>(app.db, "select value from kv where key=?", key)?.value, { attempts: 0 });
    run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value", key, JSON.stringify({ tenant, flowId, item, attempts: prev.attempts + 1, retryAt: Date.now() + 10 * 60_000, error: (error as Error).message }));
  };
  const keepMapping = (tenant: string, flowId: string, item: Record<string, any>, chatId: unknown) => {
    if (typeof chatId !== "string" || !chatId.startsWith("oc_")) return;
    const mapping: Mapping = { chatId, tenantId: tenant, flowId, evidence: `ByteCloud Oncall flow ${flowId}`, related: !!cfg.relatedTypeIds?.includes(String(item.oncall_question_type_id ?? item.type_id)) };
    run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value", `lark_oncall_map:${chatId}`, JSON.stringify(mapping));
    run(app.db, "delete from kv where key=?", `lark_oncall_failure:${tenant}:${flowId}`);
    wanted.delete(chatId);
  };
  try {
    for (const row of all<{ value: string }>(app.db, "select value from kv where key like 'lark_oncall_failure:%' and json_extract(value,'$.attempts')<3 and json_extract(value,'$.retryAt')<=? limit 2", Date.now())) {
      const failed = json<{ tenant: string; flowId: string; item: Record<string, any> }>(row.value, {} as any);
      if (!cfg.tenantIds.includes(failed.tenant)) continue;
      budget--;
      try {
        const chat = await oncall(app, ["chat", "get", "--flow-id", failed.flowId]);
        if (String(chat.flow_id) !== failed.flowId) throw new Error("Oncall 返回的工单关联不一致");
        keepMapping(failed.tenant, failed.flowId, failed.item, chat.open_chat_id);
      } catch (e) { failedMapping(failed.tenant, failed.flowId, failed.item, e); }
    }
    while (wanted.size && scan.tenant < cfg.tenantIds.length) {
      const tenant = cfg.tenantIds[scan.tenant]!;
      if (!scan.items.length) {
        if (!budget--) break;
        const v = await oncall(app, ["flow", "list", "--tenant-id", tenant, "--message-updated-within", "3d", "--page", String(scan.page), "--page-size", "100"]);
        if (!Array.isArray(v.items)) throw new Error("Oncall 工单分页格式未知");
        scan.items = [...v.items].sort((a, b) => Number(cfg.relatedTypeIds?.includes(String(b.oncall_question_type_id ?? b.type_id))) - Number(cfg.relatedTypeIds?.includes(String(a.oncall_question_type_id ?? a.type_id))));
        scan.index = 0;
        scan.more = typeof v.has_more === "boolean" ? v.has_more : typeof v.total === "number" ? scan.page * 100 < v.total : v.items.length === 100;
        if (!v.items.length && scan.more) throw new Error("Oncall 分页提前结束");
        commit();
      }
      while (scan.index < scan.items.length) {
        const item = scan.items[scan.index]!;
        const flowId = String(item.id ?? item.oncall_flow_id ?? "");
        if (String(item.tenant_id) === tenant && /^\d+$/.test(flowId)) {
          let chatId = item.open_chat_id;
          const cached = one(app.db, "select 1 from kv where key like 'lark_oncall_map:%' and json_extract(value,'$.flowId')=? and json_extract(value,'$.tenantId')=?", flowId, tenant);
          const failed = one(app.db, "select 1 from kv where key=?", `lark_oncall_failure:${tenant}:${flowId}`);
          if (!chatId && !cached && !failed) {
            if (!budget--) { commit(); return; }
            try {
              const chat = await oncall(app, ["chat", "get", "--flow-id", flowId]);
              if (String(chat.flow_id) !== flowId) throw new Error("Oncall 返回的工单关联不一致");
              chatId = chat.open_chat_id;
            } catch (e) { failedMapping(tenant, flowId, item, e); }

          }
          keepMapping(tenant, flowId, item, chatId);
        }
        scan.index++;
        commit();
        if (!wanted.size) break;
      }
      if (scan.index < scan.items.length) break;
      scan.items = []; scan.index = 0;
      if (scan.more) scan.page++;
      else { scan.tenant++; scan.page = 1; }
      commit();
    }
    if (scan.tenant >= cfg.tenantIds.length) {
      scan = { tenants: signature, tenant: 0, page: 1, items: [], index: 0, more: true, retryAt: Date.now() + 10 * 60_000 };
      commit();
    }
    run(app.db, "insert into kv(key,value) values('lark_oncall_discovery',?) on conflict(key) do update set value=excluded.value", JSON.stringify({ at: Date.now(), unmatched: [...wanted] }));
  } catch (e) {
    commit();
    run(app.db, "insert into kv(key,value) values('lark_oncall_discovery',?) on conflict(key) do update set value=excluded.value", JSON.stringify({ at: Date.now(), error: (e as Error).message }));
    throw e;
  }
}
