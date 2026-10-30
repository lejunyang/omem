import { reactive, watch } from "vue";
import { get, onServerEvent, type Space } from "./api";

export type CitationTarget =
  | { kind: "source"; id?: string; uri?: string; space?: string; from?: number; to?: number; label?: string }
  | { kind: "memory"; id: string }
  | { kind: "message"; id: string }
  | { kind: "page"; space: string; slug: string }
  /** A file a delegation or review names, read through the run (its worktree or branch). */
  | { kind: "file"; runId: string; path: string; space?: string; from?: number; to?: number };

function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export const state = reactive({
  spaces: [] as Space[],
  space: stored("omem-space", "personal"),
  unread: 0,
  toasts: [] as { id: number; text: string; kind: "info" | "ok" | "error"; link?: string }[],
  /** Stack of citation targets shown in the side drawer. */
  trail: [] as CitationTarget[],
  palette: false,
  capture: false,
  theme: stored("omem-theme", "auto"),
});

watch(
  () => state.space,
  (v) => {
    try {
      localStorage.setItem("omem-space", v);
    } catch {}
  },
);
watch(
  () => state.theme,
  (v) => {
    document.documentElement.dataset.theme = v === "auto" ? "" : v;
    try {
      localStorage.setItem("omem-theme", v);
    } catch {}
  },
  { immediate: true },
);

export async function loadSpaces() {
  state.spaces = await get<Space[]>("/api/spaces");
  if (!state.spaces.some((s) => s.id === state.space)) state.space = state.spaces[0]?.id ?? "personal";
}

export function currentSpace() {
  return state.spaces.find((s) => s.id === state.space) ?? null;
}

let toastId = 0;
export function toast(text: string, kind: "info" | "ok" | "error" = "info", link?: string) {
  const id = ++toastId;
  state.toasts.push({ id, text, kind, link });
  setTimeout(() => {
    const i = state.toasts.findIndex((t) => t.id === id);
    if (i >= 0) state.toasts.splice(i, 1);
  }, kind === "error" ? 8000 : 4500);
}

export function openCitation(target: CitationTarget, replace = false) {
  if (replace) state.trail = [target];
  else state.trail.push(target);
}

export async function refreshUnread() {
  try {
    state.unread = (await get<{ unread: number }>("/api/notifications")).unread;
  } catch {}
}

onServerEvent((e) => {
  if (e.type === "notification") {
    state.unread++;
    toast(e.title, "info", e.link ?? undefined);
  }
  if (e.type === "changed" && e.entity === "space") void loadSpaces();
});

/** What a source is, in words (search hits, lists). */
export const sourceKindLabel: Record<string, string> = { doc: "文档", code: "代码", chat: "聊天", note: "笔记", web: "网页", image: "图片", conversation: "对话", meeting: "会议", event: "日程", activity: "动态", work: "工作文件" };
export const kindLabel: Record<string, string> = {
  personal: "个人",
  project: "项目",
  repo: "代码仓库",
  learning: "学习",
  topic: "通用",
};
export const runKindLabel: Record<string, string> = {
  ask: "问答",
  ingest: "整理新材料",
  archive: "原件归档",
  "archive-rule-draft": "编写归档规则",
  "wiki-plan": "规划目录",
  "wiki-write": "写作页面",
  "wiki-lint": "检查页面",
  "wiki-organize": "整理 Wiki 目录",
  heartbeat: "巡检",
  dream: "整理记忆",
  code: "交办编码",
  review: "评审",
  tutor: "生成卡片",
  sync: "同步目录",
  brief: "简报",
  curate: "筛选关注群",
  "ingest-shadow": "对比整理",
  "memory-review": "复核记忆",
  "memory-organize": "整理记忆目录",
  "agent-followup": "消化结论",
  "thread-summary": "会话摘要",
  "learn-feed": "学习出卡",
  agent: "Agent 档案",
  guest: "访客提问",
  "lark-command": "私聊指令",
  "lark-resource-parse": "解析附件",
  "rule-fire": "规则（等待后）",
  "profile-review": "复盘",
  "role-merge": "合并角色",
  "peer-agent": "同伴的外部 Agent",
  replay: "夜间复盘",
  "replay-arm": "复盘重答",
  "replay-judge": "复盘评判",
};
export const statusLabel: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
  open: "进行中",
  waiting: "等待中",
  snoozed: "稍后",
  cancelled_item: "已取消",
  active: "有效",
  superseded: "已被更正",
  retracted: "已撤回",
};
export const memoryKindLabel: Record<string, string> = {
  fact: "事实",
  agreement: "约定",
  preference: "偏好",
  experience: "经验",
  person: "人物",
  decision: "决定",
};
export const itemKindLabel: Record<string, string> = {
  todo: "待办",
  waiting: "等待回复",
  reminder: "提醒",
  watch: "关注",
  decision: "待决定",
};

export function fmtTime(iso: string | null | undefined, withTime = true) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts: Intl.DateTimeFormatOptions = sameDay ? { hour: "2-digit", minute: "2-digit" } : withTime ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" } : { year: "numeric", month: "numeric", day: "numeric" };
  return (sameDay ? "今天 " : "") + d.toLocaleString("zh-CN", opts);
}

export function relTime(iso: string | null | undefined) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Math.abs(diff) < 60) return "刚刚";
  const fut = diff < 0;
  const a = Math.abs(diff);
  const s = a < 3600 ? `${Math.round(a / 60)} 分钟` : a < 86400 ? `${Math.round(a / 3600)} 小时` : `${Math.round(a / 86400)} 天`;
  return fut ? `${s}后` : `${s}前`;
}
