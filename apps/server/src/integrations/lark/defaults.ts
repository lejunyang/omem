import { larkRequestedConfigSchema } from "../../../../../packages/contracts/src/index.js";

/**
 * Subset derived from botmux source revision 597ffb10172ea9ac2b50b75507d52a8cf5fb0cd7.
 * It intentionally excludes group creation/member mutation, urgent channels,
 * document, calendar, meeting and feed-label permissions that omem does not need.
 */
export const OMEM_LARK_DEFAULT_CONFIG = larkRequestedConfigSchema.parse({
  source: "omem",
  appPreset: {
    name: "{user}的 omem 助理",
    desc: "在授权群聊中记录工作材料，并向 owner 发送记忆变更、提醒和确认。",
  },
  addons: {
    preset: false,
    scopes: {
      tenant: [
        "im:message",
        "im:message:send_as_bot",
        "im:message:update",
        "im:message.p2p_msg:readonly",
        "im:message.group_at_msg:readonly",
        "im:message.group_at_msg.include_bot:readonly",
        "im:message.group_msg",
        "im:message.group_msg.include_bot:read",
        "im:resource",
        "im:chat:read",
        "im:chat.members:read",
        "contact:user.base:readonly",
        "application:bot.basic_info:read",
      ],
      user: [],
    },
    events: {
      items: {
        tenant: [
          "im.message.receive_v1",
          "im.message.updated_v1",
          "im.chat.member.bot.added_v1",
          "im.chat.member.bot.deleted_v1",
        ],
        user: [],
      },
    },
    callbacks: { items: ["card.action.trigger"] },
  },
});
