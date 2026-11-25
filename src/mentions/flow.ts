import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { HttpError, json } from "../core/util.ts";
import { otherItemForEvidence, overlappingRefs, reopenForEvidence, withFollowEvidence } from "../flows/follow-evidence.ts";
import { itemFlow, type FlowActor } from "../flows/store.ts";
import { itemPlaces } from "../items/places.ts";
import { getItem, isClosed, type Item } from "../items/store.ts";
import type { MentionInfo } from "./channel.ts";

function linkedPlace(app: App, item: Item, mention: MentionInfo) {
  const sources = new Set(mention.refs.map(ref => ref.slice(4).split("#")[0]));
  return itemPlaces(app, item.id, item.userId).some(p => {
    if (p.kind === "source") {
      return sources.has(p.ref) || (mention.channel ?? "lark") === "lark" &&
        !!one(app.db, "select 1 from sources where id=? and uri=?", p.ref, `lark:${mention.chatId}`);
    }
    if ((mention.channel ?? "lark") !== "lark") return false;
    const topic = mention.topicId ? `${mention.chatId}#${mention.topicId}` : mention.chatId;
    return !!one(app.db, "select 1 from conversations where id=? and user_id=? and channel like 'lark%' and external_id in (?,?)",
      p.ref, item.userId, mention.chatId, topic);
  });
}

export function reopenFromMention(app: App, item: Item, stage: string, reason: string, refs: string[], by: FlowActor, mention: MentionInfo) {
  return withFollowEvidence(app, item.userId, async () => {
    const current = getItem(app, item.id), flow = itemFlow(app, item.id);
    if (!flow || flow.endedAt || isClosed(current.status) || current.status === "candidate") throw new HttpError(409, "这件事项没有在推进的流程");
    if (!linkedPlace(app, current, mention)) throw new HttpError(403, "事项材料里没有找本人的会话");
    const citesTrigger = overlappingRefs(app, refs);
    const triggerRefs = mention.refs.filter(ref => citesTrigger([ref]));
    if (!triggerRefs.length) throw new HttpError(400, "重开阶段要引用触发这次处理的原话");
    // Only use the triggering lines for deduplication here. Other evidence may be shared across fixes.
    const reopened = reopenForEvidence(app, item.id, flow.startedAt, triggerRefs);
    if (reopened) return { reopened: false, item: item.id, stage: reopened.stage_id, note: "这个阶段已经按这段原话重开，接着由流程处理。" };
    const overlapsTrigger = overlappingRefs(app, triggerRefs);
    const waiting = all<{ refs: string }>(app.db, `select refs from item_changes
      where item_id=? and status='asked' and type in ('scope','decision','blocker')`, item.id);
    if (waiting.some(row => overlapsTrigger(json<string[]>(row.refs, []))))
      throw new HttpError(409, "这段原话的变更在等本人决定");
    const other = otherItemForEvidence(app, item, triggerRefs);
    if (other) return { reopened: false, item: other.id, note: `这段原话已经由事项「${other.title}」接手，先读该事项核对现状。` };
    const { reopenStage } = await import("../flows/engine.ts");
    const feedback = `${reason}\n依据：${refs.join(" ")}`;
    return reopenStage(app, item.id, stage, feedback, refs, by, { feedback: true, startedAt: flow.startedAt });
  });
}
