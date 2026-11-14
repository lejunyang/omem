import type { App } from "../core/app.ts";
import { OWNER, identitiesOf, registerChannelOwner, resolveIdentity } from "../core/users.ts";
import { addNotificationSink } from "../core/notify.ts";
import { registerThreadSender } from "../agents/inbox.ts";
import { answerFromChannel, chunkMessage } from "../channels/common.ts";
import type { LoadedPlugin } from "./registry.ts";
import type { PluginChannel, PluginChannelMessage } from "./types.ts";

export type ChannelState = { id: string; label: string; running: boolean; lastError: string | null };

/** Platform code only supplies send and receive; identities, turns and cleanup belong to the host. */
export function registerPluginChannel(app: App, p: LoadedPlugin, def: PluginChannel) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(def.id) || !def.label.trim() || !Number.isInteger(def.maxLength) || def.maxLength < 2) throw new Error("渠道需要合法的 id、名称和 maxLength（至少 2）");
  const id = `${p.manifest.id}-${def.id}`;
  if (p.channels.some((c) => c.id === id && c.running)) throw new Error(`已经有渠道 ${id}`);
  const state: ChannelState = { id, label: def.label, running: true, lastError: null };
  const owner = () => String(def.owner?.(p.env.settings(app, OWNER)) ?? "").trim();
  const send = async (to: { chatId: string; topicId?: string }, text: string) => {
    for (const part of chunkMessage(text, def.maxLength)) {
      if (!state.running) return;
      try { await def.send(to, part); state.lastError = null; }
      catch (e) { state.lastError = e instanceof Error ? e.message : String(e); console.warn(`[omem] 插件渠道 ${id} 发送失败：${state.lastError}`); return; }
    }
  };
  const undoOwner = registerChannelOwner(app, id, owner);
  const undoSender = registerThreadSender(id, async (thread, text) => {
    const [chatId, topicId] = (thread.key ?? "").split("#");
    if (chatId) await send({ chatId, topicId: thread.settings.lastTopicId ?? topicId }, text);
  });
  const undoSink = addNotificationSink(async (n) => {
    const to = (n.userId === OWNER ? owner() : "") || identitiesOf(app, n.userId).find((i) => i.channel === id)?.external_id;
    if (to) await send({ chatId: to }, `${n.title}\n${n.body}`);
  });
  return {
    state,
    stop() { state.running = false; undoSender(); undoSink(); undoOwner(); },
    async receive(m: PluginChannelMessage) {
      if (!state.running || !m.text || (m.isGroup && !m.addressed)) return;
      const userId = resolveIdentity(app, id, m.senderId);
      if (!userId) {
        if (!m.isGroup && !owner()) await send({ chatId: m.chatId }, `还没有绑定本人。请在 设置 → 插件 → ${p.manifest.name} 填本人在这个平台上的 id：${m.senderId}`);
        return;
      }
      try {
        const answer = await answerFromChannel(app, { channel: id, chatId: m.chatId, topicId: m.topicId, isGroup: m.isGroup, text: m.text, externalMessageId: m.messageId, userId });
        if (answer !== null) await send({ chatId: m.chatId, topicId: m.topicId }, answer || "（没有回答）");
      } catch (e) { await send({ chatId: m.chatId, topicId: m.topicId }, `处理失败：${(e as Error).message}`); }
    },
  };
}
