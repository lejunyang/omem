/**
 * Where notifications and questions go besides the page itself (`GET /api/notify/outlets`,
 * src/plugins/notifier.ts): the built-in web and Feishu, and the outlets plugins register. Each person
 * sets their own: on or off (a plugin outlet with no setting is off), the least urgency it gets, and which
 * kinds of question it may carry. Ordinary questions and suggestions may go anywhere; approvals only
 * through an outlet the owner opened them for (the owner's own: always). Pure.
 */
export type Urgency = "later" | "normal" | "urgent";
export type OutletSetting = { id: string; minUrgency: Urgency; askKinds: string[] };
export type Outlet = {
  id: string; name: string; plugin: string | null; builtin: boolean; supportsAsk: boolean;
  reachable: { ok: boolean; hint?: string }; setting: OutletSetting | null;
  lastDelivery: string | null; lastError?: string | null;
};

export const URGENCY_OPTIONS: { value: Urgency; label: string }[] = [
  { value: "later", label: "不急的也发" },
  { value: "normal", label: "一般及以上" },
  { value: "urgent", label: "只发紧急的" },
];
/** The kinds of question the page offers to route; `approval` needs the owner's opening for others. */
export const ASK_KINDS: { kind: string; label: string; hint: string }[] = [
  { kind: "question", label: "提问和选择", hint: "要你选一个或回一句话" },
  { kind: "suggestion", label: "下一步建议", hint: "助手提议的几个做法" },
  { kind: "approval", label: "审批", hint: "批准命令、工具或操作" },
];
export const ordinaryKind = (kind: string) => kind === "question" || kind === "suggestion";

/** The settings to send back (`PUT /api/notify/outlets` replaces the list): every plugin outlet that is on. */
export function outletSettings(outlets: Outlet[]): OutletSetting[] {
  return outlets.filter((o) => !o.builtin && o.setting).map((o) => ({ id: o.id, minUrgency: o.setting!.minUrgency, askKinds: [...o.setting!.askKinds] }));
}

/** One outlet changed: on (with a first setting), off, or a part of its setting. */
export function withOutlet(outlets: Outlet[], id: string, change: { on?: boolean; minUrgency?: Urgency; askKinds?: string[] }): Outlet[] {
  return outlets.map((o) => {
    if (o.id !== id || o.builtin) return o;
    if (change.on === false) return { ...o, setting: null };
    const base: OutletSetting = o.setting ?? { id: o.id, minUrgency: "normal", askKinds: o.supportsAsk ? ["question"] : [] };
    return { ...o, setting: { ...base, ...(change.minUrgency ? { minUrgency: change.minUrgency } : {}), ...(change.askKinds ? { askKinds: change.askKinds } : {}) } };
  });
}

/** Whether this kind may be ticked here: ordinary ones always; approvals for the owner, or once opened for this outlet. */
export function kindAllowed(o: Outlet, kind: string, owner: boolean) {
  return owner || ordinaryKind(kind) || !!o.setting?.askKinds.includes(kind);
}

/** The line under an outlet's name: where it comes from and when it last delivered. */
export function outletMeta(o: Outlet, when: (iso: string) => string) {
  const from = o.builtin ? "内置" : o.plugin ? `插件 ${o.plugin}` : "";
  const last = o.lastDelivery ? `上次投递 ${when(o.lastDelivery)}` : o.builtin ? "" : "还没投递过";
  return [from, last].filter(Boolean).join(" · ");
}
