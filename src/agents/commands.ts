import { effortsFor, type ProbeInfo } from "./probe.ts";
import type { App } from "../core/app.ts";
import { allProfiles, saveConfig, type Config } from "../core/config.ts";
import { findSpace, listSpaces, relatedIds } from "../core/spaces.ts";
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
 * /new and /topic can return a fresh conversation with a task for the model.
 * Unknown `/words` fall through to the assistant as ordinary text.
 */
type Ctx = { app: App; thread: Thread; args: string; inb: Inbound };
type CommandResult = string | { thread: Thread; task: string; reply?: string };
type Command = { usage: string; help: string; card?: (c: Ctx) => Record<string, unknown> | Promise<Record<string, unknown>>; run: (c: Ctx) => CommandResult | Promise<CommandResult> };

const chatKey = (t: Thread) => (t.key ?? "").split("#")[0];

const commands: Record<string, Command> = {
  help: {
    usage: "/help",
    help: "列出命令",
    run: () =>
      [
        "**会话**",
        ...["new", "topic", "status", "stop", "sessions", "resume", "link", "summary", "compact"].map(line),
        "",
        "**路由**",
        ...["space", "agent", "model", "as", "agents", "skills", "approve", "mode", "idle", "watch"].map(line),
        "",
        "**快捷**",
        ...["remember", "todo", "search", "review", "runs", "whoami"].map(line),
        "",
        "其他文字照常交给助理。",
      ].join("\n"),
  },
  new: {
    usage: "/new [任务]",
    help: "开始新会话并立即执行后面的任务；不带任务只开空白会话（旧会话可用 /resume 找回）",
    run: async ({ app, thread, args, inb }) => {
      releaseThreadSession(thread.id);
      archiveThread(app, thread.id);
      maybeSummarize(app, thread.id, 2);
      const t = createThread(app, { spaceId: thread.spaceId, channel: thread.channel, key: thread.key, title: truncate(args.replace(/\s+/g, " "), 60), parentId: null, userId: inb.userId ?? OWNER, settings: freshSettings(thread) });
      return { thread: t, task: args, reply: `已开始新会话 ${t.id}。上一个会话 ${thread.id} 已归档，需要时 /resume ${thread.id}。` };
    },
  },
  topic: {
    usage: "/topic <任务>",
    help: "把普通飞书群聊中的本条消息作为话题根消息，在独立上下文中执行任务；话题内不接受此指令",
    run: async ({ app, thread, args, inb }) => {
      if (inb.topicId) return "已经在话题中，不能使用 /topic。请直接发送任务，或回到群聊主界面发起新话题。";
      if (inb.channel !== "lark" || !inb.isGroup || !inb.chatId || !inb.openTopic) return "请在飞书群聊主界面 @ 机器人发送 /topic 任务描述；私聊和其他渠道可用 /new 任务描述。";
      if (!args) return "用法：/topic 任务描述";
      const topic = await inb.openTopic();
      const key = `${inb.chatId}#${topic.topicId}`;
      const t = createThread(app, { spaceId: thread.spaceId, channel: "lark", key, title: truncate(args.replace(/\s+/g, " "), 60), userId: inb.userId ?? OWNER,
        settings: { ...freshSettings(thread), isolatedTopic: true, lastMessageId: topic.messageId } });
      return { thread: t, task: args };
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
        `空间：${t.spaceId} · 回答者：${t.settings.spec ? `Agent 档案 ${t.settings.spec}` : "助理"}${t.settings.profile ? ` · 后端 ${t.settings.profile}` : ""}${t.settings.model || t.settings.effort ? ` · 本会话模型 ${t.settings.model ?? "默认"}/${t.settings.effort ?? "默认"}` : ""}`,
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
  model: {
    card: (c) => modelCardCommand(c),
    usage: "/model [模型名] [effort=low|medium|high] | off | save <模型> [effort=…]",
    help: "查看/临时更换本会话的模型和思考强度；save 存为该任务的默认；off 恢复默认。模型名不区分大小写、点和连字符（GPT-Sol-6.1 = gpt-6.1-sol）",
    run: async ({ app, thread, args, inb }) => {
      const text = args.trim();
      const profiles = allProfiles(app.config);
      const profileId = thread.settings.profile ?? app.config.agents.default ?? profiles[0]?.id;
      const profile = profiles.find((p) => p.id === profileId);
      const probe = cachedProbeSync(app, profileId);
      if (!text) {
        // In Feishu the bare command opens the interactive model card; elsewhere show text.
        if (inb.channel === "lark") {
          const card = await commands.model.card?.({ app, thread, args: "", inb });
          if (card) return JSON.stringify({ __omem_card: card });
        }
        const models = probe?.models ?? (profile?.model ? [profile.model] : []);
        return [
          `后端：${profileId ?? "未配置"}`,
          `本会话：${thread.settings.model ?? "默认模型"} / ${thread.settings.effort ?? "默认强度"}${thread.settings.model || thread.settings.effort ? "（仅本会话生效）" : ""}`,
          models.length ? `可选模型：${models.join(", ")}` : "还没探测过可选模型（网页 Agent 页点“检测模型”，或 /model save 直接填名字）",
          ((m) => {
            const list = effortsFor(probe, m);
            if (probe?.effortsByModel && m && !list.length) return `${m} 没有思考强度设置`;
            return list.length ? `可选强度${m && probe?.effortsByModel ? `（${m}）` : ""}：${list.join(", ")}` : "";
          })(thread.settings.model ?? profile?.model),
          "用法：/model gpt-6.1-sol effort=high（本会话）｜/model save gpt-6.1-sol effort=low（存为这类任务默认）｜/model off（恢复默认）",
        ].filter(Boolean).join("\n");
      }
      if (text === "off") {
        updateThread(app, thread.id, { settings: { model: null, effort: null } });
        releaseThreadSession(thread.id);
        return "本会话恢复使用默认模型和思考强度。";
      }
      const persist = text.startsWith("save ");
      const { model, effort } = parseModelArgs(persist ? text.slice(5) : text);
      if (!model && !effort) return "没看出要改成什么。用法：/model 模型名 effort=low|medium|high";
      if (persist) {
        // An agent spec answering here carries its own model/effort: save it on the spec, since
        // role defaults never apply to spec runs.
        const answering = thread.settings.spec ? findAgentSpec(app, thread.settings.spec) : null;
        if (answering) {
          saveAgentSpec(app, { name: answering.name, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, "user");
          return `已把 Agent 档案 ${answering.name} 的默认改为 ${model ?? "模型不变"} / ${effort ?? "强度不变"}。`;
        }
        const role = "assistant";
        const next = structuredClone(app.config) as Config;
        const roles = new Map(Object.entries(next.agents.roleModels ?? {}));
        const byProfile = new Map(Object.entries(roles.get(role) ?? {}));
        const cur = byProfile.get(profileId!) ?? {};
        byProfile.set(profileId!, { ...cur, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        roles.set(role, Object.fromEntries(byProfile));
        next.agents.roleModels = Object.fromEntries(roles);
        saveConfig(next, app.home);
        Object.assign(app.config, next);
        return `已把 ${role} 类任务用 ${profileId} 时的默认改为 ${model ?? "模型不变"} / ${effort ?? "强度不变"}（不影响其他任务和其他会话）。`;
      }
      updateThread(app, thread.id, { settings: { model: model ?? null, effort: effort ?? null } });
      releaseThreadSession(thread.id);
      return `本会话改用 ${model ?? "默认模型"} / ${effort ?? "默认强度"}，下一条消息生效。群里只影响这个群/话题；/model off 恢复。`;
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
      const allowed = accessibleSpaces(app, inb.userId ?? OWNER);
      const related = relatedIds(app, thread.spaceId).filter((id) => !allowed || allowed.includes(id));
      const hits = await search(app, args.trim(), { spaces: [...new Set([thread.spaceId, ...related, own])], limit: 8 });
      return hits.length
        ? hits.map((h, i) => `${i + 1}. ${h.spaceId !== thread.spaceId && h.type !== "page" ? `[${h.spaceId}] ` : ""}${h.type === "page" ? `页面 ${h.path}` : h.type === "memory" ? `记忆 ${h.id}` : `${h.uri ?? h.title}${h.lineStart ? `:${h.lineStart}` : ""}`}\n   ${truncate(h.snippet.replace(/\s+/g, " "), 120)}`).join("\n")
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
  watch: {
    usage: "/watch <档案|off> [all|mention|keyword:<正则>] [none|draft|auto]",
    help: "（在群里或带 oc_ 群 id）把这个群的消息交给某个 Agent 档案处理",
    run: async ({ app, thread, args, inb }) => {
      if ((inb.userId ?? OWNER) !== OWNER) return "只有本人可以设置群监听。";
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const chatId = parts[0]?.startsWith("oc_") ? parts.shift()! : thread.channel === "lark" ? chatKey(thread) : "";
      if (!chatId) return "在飞书群里发这个命令，或写上群 id：/watch oc_xxx 档案名 …";
      const { setWatchRule, watchRule } = await import("../channels/lark-watch.ts");
      const spec = parts[0];
      if (!spec) {
        const r = watchRule(app, chatId);
        return r ? `${chatId} 交给 ${r.spec} 处理：${r.on}${r.pattern ? ` ${r.pattern}` : ""}，回复 ${r.reply}` : `${chatId} 没有设置监听。`;
      }
      if (spec === "off") {
        setWatchRule(app, chatId, null);
        return `已取消 ${chatId} 的监听。`;
      }
      const onArg = parts.find((p) => /^(all|mention|keyword:)/.test(p)) ?? "all";
      const reply = (parts.find((p) => /^(none|draft|auto)$/.test(p)) ?? "draft") as "none" | "draft" | "auto";
      const on = onArg.startsWith("keyword:") ? "keyword" : (onArg as "all" | "mention");
      setWatchRule(app, chatId, { spec, on, pattern: on === "keyword" ? onArg.slice(8) : undefined, reply });
      return `已设置：${chatId} 的${on === "all" ? "新消息" : on === "mention" ? " @ 消息" : `匹配 ${onArg.slice(8)} 的消息`}交给 ${spec}，回复方式 ${reply}${reply === "auto" ? "（机器人需要在群里）" : ""}。`;
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
export async function runCommand(app: App, thread: Thread, text: string, inb: Inbound): Promise<CommandResult | null> {
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

/** Keep routing and posting permissions, but leave history and temporary model/review state behind. */
function freshSettings(thread: Thread): Thread["settings"] {
  const { spec, profile, lark, isolatedTopic } = thread.settings;
  return { spec, profile, lark, isolatedTopic };
}

/** Message history helper for /status-like views elsewhere. */
export function lastMessages(app: App, threadId: string, n = 5) {
  return threadMessages(app, threadId, { limit: n });
}

// /model card for Feishu (built from the thread's current model state).
async function modelCardCommand(c: Ctx) {
  const { modelCard } = await import("../channels/lark-model-card.ts");
  return modelCard(c.app, c.thread.id);
}

// /model helpers: probe cache and loose "name effort=high" parsing.
function cachedProbeSync(app: App, profileId?: string) {
  if (!profileId) return null;
  const row = app.db.prepare("select value from kv where key = ?").get(`probe:${profileId}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as ProbeInfo;
  } catch {
    return null;
  }
}
export function parseModelArgs(text: string): { model?: string; effort?: string } {
  const effort = /\beffort\s*[=:]\s*([a-z0-9.-]+)/i.exec(text)?.[1]?.toLowerCase();
  const model = text.replace(/\beffort\s*[=:]\s*[a-z0-9.-]+/i, "").trim() || undefined;
  return { model, effort };
}
