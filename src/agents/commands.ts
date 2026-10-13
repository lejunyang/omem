import type { App } from "../core/app.ts";
import { allProfiles } from "../core/config.ts";
import { findSpace, listSpaces } from "../core/spaces.ts";
import { truncate } from "../core/util.ts";
import { upsertItem } from "../items/store.ts";
import { dueCards, getCard, reviewCard, studyStats } from "../learn/cards.ts";
import { accessibleSpaces, OWNER, userName } from "../core/users.ts";
import { remember } from "../memory/store.ts";
import { search } from "../search/search.ts";
import type { Inbound } from "./inbox.ts";
import { cancelRun, createRun, listRuns, runsInLane } from "./runs.ts";
import { liveSessionInfo, maybeSummarize, releaseThreadSession } from "./sessions.ts";
import { findAgentSpec, listAgentSpecs, listSkills, setSkillStatus, findSkill, saveAgentSpec } from "./specs.ts";
import {
  archiveThread,
  chatSettings,
  createThread,
  describeThread,
  findThread,
  listThreads,
  reattachThread,
  resetAgentSession,
  setChatSettings,
  threadMessages,
  updateThread,
  type Thread,
} from "./threads.ts";

/**
 * Slash commands talk to omem itself, without a model: thread control
 * (/new /resume /link /stop /status), routing (/space /agent /as /mode),
 * quick capture (/remember /todo) and lookups (/search /sessions /runs).
 * Unknown `/words` fall through to the assistant as ordinary text.
 */
type Ctx = { app: App; thread: Thread; args: string; inb: Inbound };
type Command = { usage: string; help: string; run: (c: Ctx) => string | Promise<string> };

const chatKey = (t: Thread) => (t.key ?? "").split("#")[0];

const commands: Record<string, Command> = {
  help: {
    usage: "/help",
    help: "列出命令",
    run: () =>
      [
        "**会话**",
        ...["new", "status", "stop", "sessions", "resume", "link", "summary", "compact"].map(line),
        "",
        "**路由**",
        ...["space", "agent", "as", "agents", "skills", "approve", "mode", "idle"].map(line),
        "",
        "**快捷**",
        ...["remember", "todo", "search", "review", "runs", "whoami"].map(line),
        "",
        "其他文字照常交给助理。",
      ].join("\n"),
  },
  new: {
    usage: "/new [标题]",
    help: "结束当前会话，开始新的（旧会话可用 /resume 找回）",
    run: ({ app, thread, args }) => {
      releaseThreadSession(thread.id);
      archiveThread(app, thread.id);
      maybeSummarize(app, thread.id, 2);
      const t = createThread(app, { spaceId: thread.spaceId, channel: thread.channel, key: thread.key, title: args, parentId: null, settings: { spec: thread.settings.spec, profile: thread.settings.profile } });
      return `已开始新会话 ${t.id}${args ? `「${args}」` : ""}。上一个会话 ${thread.id} 已归档，需要时 /resume ${thread.id}。`;
    },
  },
  status: {
    usage: "/status",
    help: "当前会话的空间、Agent、会话状态和排队情况",
    run: ({ app, thread }) => {
      const t = findThread(app, thread.id)!;
      const liveInfo = liveSessionInfo(t.id);
      const lane = runsInLane(app, t.id);
      const cs = t.key ? chatSettings(app, t.channel, chatKey(t)) : {};
      const [profileId, actor] = (t.agentProfile ?? "").split("|");
      return [
        `会话 ${t.id}「${t.title || "(无标题)"}」 · ${t.channel}${t.key ? ` ${t.key}` : ""}`,
        `空间：${t.spaceId} · 回答者：${t.settings.spec ? `Agent 档案 ${t.settings.spec}` : "助理"}${t.settings.profile ? ` · 后端 ${t.settings.profile}` : ""}`,
        `Agent 会话：${liveInfo ? `在线（${liveInfo.agent}，空闲 ${liveInfo.idleSeconds} 秒）` : t.agentSession ? `可恢复（${profileId ?? ""}${actor ? " / " + actor : ""}）` : "无（下一条消息新建）"} · 已进行 ${t.agentTurns} 轮`,
        lane.length ? `进行中：${lane.map((r) => `${r.id} ${r.status === "running" ? "运行中" : "排队"}「${truncate(r.title, 30)}」`).join("；")}` : "没有进行中的任务",
        t.key ? `群设置：${cs.mode === "topic" ? "每个话题独立会话" : cs.mode === "chat" ? "整个群一个会话" : "默认（有话题时按话题）"}${cs.spaceId ? ` · 空间 ${cs.spaceId}` : ""}` : "",
        t.parentId ? `上一段会话：${t.parentId}` : "",
        t.settings.links?.length ? `关联会话：${t.settings.links.join(", ")}` : "",
        t.summary ? `摘要：${truncate(t.summary.replace(/\s+/g, " "), 200)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
  stop: {
    usage: "/stop",
    help: "停止本会话正在运行和排队的任务",
    run: ({ app, thread }) => {
      const lane = runsInLane(app, thread.id);
      for (const r of lane) cancelRun(app, r.id);
      return lane.length ? `已停止 ${lane.length} 个任务。` : "没有正在运行的任务。";
    },
  },
  sessions: {
    usage: "/sessions [关键词]",
    help: "最近的会话（含其他群和渠道）",
    run: ({ app, args, inb }) => {
      const list = listThreads(app, { query: args || undefined, limit: 12, includeArchived: !!args, userId: inb.userId ?? OWNER });
      return list.length ? list.map(describeThread).join("\n") : "没有找到会话。";
    },
  },
  resume: {
    usage: "/resume <会话id>",
    help: "在这里继续一个以前的会话（包括它的 Agent 会话）",
    run: ({ app, thread, args }) => {
      const target = findThread(app, args.trim());
      if (!target) return `找不到会话 ${args}。用 /sessions 查看。`;
      if (target.id === thread.id) return "已经在这个会话里了。";
      releaseThreadSession(thread.id);
      if (thread.key) reattachThread(app, target.id, thread.channel, thread.key);
      return `已切换到会话 ${target.id}「${target.title}」。${thread.key ? "" : "（网页里请直接打开该会话。）"}`;
    },
  },
  link: {
    usage: "/link <会话id>",
    help: "把另一个会话的摘要作为本会话的背景（/link -<id> 取消）",
    run: ({ app, thread, args }) => {
      const id = args.trim().replace(/^-/, "");
      const target = findThread(app, id);
      if (!target) return `找不到会话 ${id}。`;
      const links = new Set(thread.settings.links ?? []);
      args.trim().startsWith("-") ? links.delete(target.id) : links.add(target.id);
      updateThread(app, thread.id, { settings: { links: [...links] } });
      resetAgentSession(app, thread.id);
      releaseThreadSession(thread.id);
      maybeSummarize(app, target.id, 2);
      return `${args.trim().startsWith("-") ? "已取消关联" : "已关联"}会话 ${target.id}「${target.title}」。下一条消息起生效。`;
    },
  },
  summary: {
    usage: "/summary [refresh]",
    help: "查看本会话摘要；refresh 立即重新整理",
    run: ({ app, thread, args }) => {
      if (args.trim() === "refresh") {
        const r = maybeSummarize(app, thread.id, 1);
        return r ? `正在整理摘要（${r.id}）。` : "没有新的内容需要整理，或已在整理中。";
      }
      return thread.summary || "还没有摘要（消息够多时会自动整理，或 /summary refresh）。";
    },
  },
  compact: {
    usage: "/compact",
    help: "整理摘要并换用新的 Agent 会话（上下文太长或跑偏时）",
    run: ({ app, thread }) => {
      releaseThreadSession(thread.id);
      resetAgentSession(app, thread.id);
      maybeSummarize(app, thread.id, 1);
      return "下一条消息将从摘要和最近消息开始新的 Agent 会话。";
    },
  },
  space: {
    usage: "/space [空间id]",
    help: "查看或切换本会话的空间（群里同时设为该群默认空间）",
    run: ({ app, thread, args, inb }) => {
      const id = args.trim();
      if (!id) return `当前空间：${thread.spaceId}\n可选：${listSpaces(app).map((s) => s.id).join(", ")}`;
      if (!findSpace(app, id)) return `没有空间 ${id}。可选：${listSpaces(app).map((s) => s.id).join(", ")}`;
      const allowed = accessibleSpaces(app, inb.userId ?? OWNER);
      if (allowed && !allowed.includes(id)) return `你不能访问空间 ${id}。`;
      updateThread(app, thread.id, { spaceId: id });
      if (thread.key) setChatSettings(app, thread.channel, chatKey(thread), { spaceId: id });
      resetAgentSession(app, thread.id);
      releaseThreadSession(thread.id);
      return `本会话改用空间 ${id}。`;
    },
  },
  agent: {
    usage: "/agent [后端id|default]",
    help: "本会话使用哪个后端 Agent（codex、claude…）",
    run: ({ app, thread, args }) => {
      const id = args.trim();
      const profiles = allProfiles(app.config);
      if (!id) return `当前：${thread.settings.profile ?? "默认"}\n可选：${profiles.map((p) => `${p.id}${p.model ? `(${p.model})` : ""}`).join(", ")}`;
      if (id !== "default" && !profiles.some((p) => p.id === id)) return `没有后端 ${id}。可选：${profiles.map((p) => p.id).join(", ")}`;
      updateThread(app, thread.id, { settings: { profile: id === "default" ? undefined : id } });
      releaseThreadSession(thread.id);
      return `本会话改用 ${id === "default" ? "默认后端" : id}。`;
    },
  },
  as: {
    usage: "/as <档案名|off> [任务]",
    help: "让某个 Agent 档案接管本会话；带任务时只交给它做这一件事",
    run: ({ app, thread, args }) => {
      const [name, ...rest] = args.trim().split(/\s+/);
      if (!name) return `当前回答者：${thread.settings.spec ?? "助理"}。可用档案：${listAgentSpecs(app).map((a) => a.name).join(", ") || "（还没有）"}`;
      if (name === "off") {
        updateThread(app, thread.id, { settings: { spec: undefined } });
        releaseThreadSession(thread.id);
        if (thread.key) setChatSettings(app, thread.channel, chatKey(thread), { spec: undefined });
        return "本会话恢复由助理回答。";
      }
      const spec = findAgentSpec(app, name);
      if (!spec) return `没有档案 ${name}。可用：${listAgentSpecs(app).map((a) => a.name).join(", ") || "（还没有，可以让助理帮你建）"}`;
      if (spec.status !== "active") return `档案 ${name} 还是草稿，先 /approve agent ${name}。`;
      const task = rest.join(" ");
      if (task) {
        const r = createRun(app, { kind: "agent", spaceId: spec.space ?? thread.spaceId, title: `${spec.name}：${truncate(task, 50)}`, input: { spec: spec.name, task, threadId: thread.id } });
        return `已交给 ${spec.name}（${r.id}），完成后结果会发回这里。`;
      }
      updateThread(app, thread.id, { settings: { spec: spec.name } });
      releaseThreadSession(thread.id);
      return `本会话改由 ${spec.name} 回答：${spec.description}\n（/as off 恢复助理）`;
    },
  },
  agents: {
    usage: "/agents",
    help: "Agent 档案列表（含草稿）",
    run: ({ app }) => {
      const list = listAgentSpecs(app, { includeDrafts: true });
      return list.length ? list.map((a) => `- ${a.name}${a.status === "draft" ? "（草稿）" : ""}：${a.description}`).join("\n") : "还没有 Agent 档案。可以对助理说“建一个负责 xx 的 Agent”。";
    },
  },
  skills: {
    usage: "/skills",
    help: "技能列表（含草稿）",
    run: ({ app }) => {
      const list = listSkills(app, { includeDrafts: true });
      return list.length ? list.map((s) => `- ${s.name}${s.status === "draft" ? "（草稿）" : ""}：${s.description}`).join("\n") : "还没有技能。可以对助理说“把刚才的做法记成技能”。";
    },
  },
  approve: {
    usage: "/approve <agent|skill> <名称>",
    help: "启用助理或整理任务起草的档案/技能",
    run: ({ app, args }) => {
      const [kind, name] = args.trim().split(/\s+/);
      if (kind === "skill" && name && findSkill(app, name)) return (setSkillStatus(app, name, "active", "user"), `技能 ${name} 已启用。`);
      if (kind === "agent" && name && findAgentSpec(app, name)) return (saveAgentSpec(app, { name, status: "active" }, "user"), `Agent 档案 ${name} 已启用。`);
      return "用法：/approve agent <名称> 或 /approve skill <名称>";
    },
  },
  mode: {
    usage: "/mode [chat|topic]",
    help: "群里：整个群一个会话（chat），还是每个话题各自独立（topic）",
    run: ({ app, thread, args }) => {
      if (!thread.key) return "只有群聊和私聊会话可以设置。";
      const v = args.trim();
      if (v !== "chat" && v !== "topic") return `当前：${chatSettings(app, thread.channel, chatKey(thread)).mode ?? "默认（有话题时按话题）"}。用法：/mode chat 或 /mode topic`;
      setChatSettings(app, thread.channel, chatKey(thread), { mode: v });
      return v === "topic" ? "此群的每个话题将各自是一个会话。" : "此群的所有消息（包括话题）将共用一个会话。";
    },
  },
  idle: {
    usage: "/idle <小时>",
    help: "此聊天空闲多久后自动开始新会话（0 表示不自动）",
    run: ({ app, thread, args }) => {
      if (!thread.key) return "网页会话不会自动更换。";
      const h = Number(args.trim());
      if (!Number.isFinite(h) || h < 0) return `当前：${chatSettings(app, thread.channel, chatKey(thread)).idleHours ?? app.config.sessions.idleHours} 小时。用法：/idle 12`;
      setChatSettings(app, thread.channel, chatKey(thread), { idleHours: h });
      return h ? `空闲超过 ${h} 小时后的消息会开始新会话（会带上上一段的摘要）。` : "此聊天不再自动开始新会话。";
    },
  },
  remember: {
    usage: "/remember <内容>",
    help: "直接记一条记忆（不经过助理）",
    run: ({ app, thread, args, inb }) => {
      if (!args.trim()) return "用法：/remember 内容";
      const m = remember(app, { spaceId: thread.spaceId, kind: "fact", content: args.trim(), createdBy: "user", sourceRefs: [`conv:${thread.id}`], userId: inb.userId && inb.userId !== OWNER ? inb.userId : null });
      return `已记住（${m.id}）。`;
    },
  },
  todo: {
    usage: "/todo <事项>",
    help: "直接记一条待办",
    run: ({ app, thread, args, inb }) => {
      if (!args.trim()) return "用法：/todo 事项";
      const i = upsertItem(app, undefined, { spaceId: thread.spaceId, kind: "todo", title: args.trim(), sourceRefs: [`conv:${thread.id}`], userId: inb.userId ?? OWNER }, "user");
      return `已加待办（${i.id}）。`;
    },
  },
  search: {
    usage: "/search <关键词>",
    help: "直接检索知识库（不经过助理）",
    run: async ({ app, thread, args, inb }) => {
      if (!args.trim()) return "用法：/search 关键词";
      const own = inb.userId && inb.userId !== OWNER ? `personal-${inb.userId}` : "personal";
      const hits = await search(app, args.trim(), { spaces: [...new Set([thread.spaceId, own])], limit: 8 });
      return hits.length
        ? hits.map((h, i) => `${i + 1}. ${h.type === "page" ? `页面 ${h.path}` : h.type === "memory" ? `记忆 ${h.id}` : `${h.uri ?? h.title}${h.lineStart ? `:${h.lineStart}` : ""}`}\n   ${truncate(h.snippet.replace(/\s+/g, " "), 120)}`).join("\n")
        : "没有命中。";
    },
  },
  review: {
    usage: "/review [目标id|stop]",
    help: "在聊天里复习到期的卡片：看题 → 回任意内容看答案 → 回 1～4 打分",
    run: ({ app, thread, args, inb }) => {
      const arg = args.trim();
      if (arg === "stop") {
        const done = thread.settings.review?.done ?? 0;
        updateThread(app, thread.id, { settings: { review: null } });
        return `已结束复习，本次复习了 ${done} 张。`;
      }
      return nextCard(app, thread, inb.userId ?? OWNER, arg || undefined, 0);
    },
  },
  whoami: {
    usage: "/whoami",
    help: "我是谁、能访问哪些空间",
    run: ({ app, inb }) => {
      const id = inb.userId ?? OWNER;
      const spaces = accessibleSpaces(app, id);
      return `${userName(app, id)}（${id}）· 可访问空间：${spaces ? spaces.join(", ") || "无" : "全部"}`;
    },
  },
  runs: {
    usage: "/runs",
    help: "最近的后台任务",
    run: ({ app }) =>
      listRuns(app, { limit: 10 })
        .map((r) => `- ${r.id} [${r.kind}/${r.status}] ${truncate(r.title, 40)}`)
        .join("\n") || "没有任务。",
  },
};

function nextCard(app: App, thread: Thread, userId: string, goalId: string | undefined, done: number): string {
  const [card] = dueCards(app, { userId, goalId }, 1);
  if (!card) {
    updateThread(app, thread.id, { settings: { review: null } });
    return done ? `复习完了，本次 ${done} 张，暂时没有到期的卡。` : "现在没有到期的卡片。";
  }
  const left = studyStats(app, { userId, goalId }).due;
  updateThread(app, thread.id, { settings: { review: { cardId: card.id, stage: "front", goalId, done } } });
  return `**${card.front}**\n\n（还有 ${left} 张。先想一想，回复任意内容看答案；/review stop 结束）`;
}

/**
 * While a review is running in this thread, plain replies drive it instead of
 * going to the assistant. Returns null when no review is active.
 */
export function reviewReply(app: App, thread: Thread, text: string, userId: string): string | null {
  const r = thread.settings.review;
  if (!r) return null;
  const t = text.trim();
  if (r.stage === "front") {
    const card = getCard(app, r.cardId);
    updateThread(app, thread.id, { settings: { review: { ...r, stage: "rate" } } });
    return `${card.back}\n\n记得怎么样？回复 1 忘了 · 2 很吃力 · 3 记得 · 4 很轻松`;
  }
  const m = /^[1-4]$/.exec(t);
  if (!m) return "回复 1～4 给这张卡打分，或 /review stop 结束复习。";
  reviewCard(app, r.cardId, Number(t) as 1 | 2 | 3 | 4);
  return nextCard(app, thread, userId, r.goalId, r.done + 1);
}

function line(name: string) {
  const c = commands[name];
  return `${c.usage} — ${c.help}`;
}

/** Run a slash command; null when the text is not a known command. */
export async function runCommand(app: App, thread: Thread, text: string, inb: Inbound): Promise<string | null> {
  const m = /^\/([a-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const cmd = commands[m[1].toLowerCase()];
  if (!cmd) return null;
  try {
    return await cmd.run({ app, thread, args: (m[2] ?? "").trim(), inb });
  } catch (e) {
    return `命令失败：${(e as Error).message}`;
  }
}

export const commandNames = Object.keys(commands);

/** Message history helper for /status-like views elsewhere. */
export function lastMessages(app: App, threadId: string, n = 5) {
  return threadMessages(app, threadId, { limit: n });
}
