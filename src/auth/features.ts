/**
 * What a person can turn on for a connected platform, and the scopes each asks for (docs/v2/multi-user.md,
 * “飞书提供方”). Feishu grants scopes incrementally: turning a feature on sends the person to the
 * authorization page with just its scopes, and the new token carries everything granted before. Scopes
 * must first be enabled for the app in the developer console (all of them, once); `offline_access` is
 * what lets omem keep working in the background (a refresh token).
 */
export type Feature = { id: string; label: string; description: string; scopes: string[] };

export const FEATURES: Record<string, Feature[]> = {
  lark: [
    { id: "offline", label: "后台访问", description: "omem 在你不在时也能读（刷新令牌）；采集类功能都要它", scopes: ["offline_access"] },
    {
      id: "messages",
      label: "我的消息",
      description: "读你的单聊和群聊，保存到你的个人空间",
      scopes: ["im:chat:read", "im:message:readonly", "im:message.group_msg:get_as_user", "im:message.p2p_msg:get_as_user", "im:resource", "contact:user.base:readonly"],
    },
    { id: "docs", label: "文档与知识库", description: "读你能看到的文档和知识库目录", scopes: ["docx:document:readonly", "docs:document.content:read", "wiki:node:read", "wiki:wiki:readonly", "drive:file:download"] },
    { id: "sheets", label: "表格与多维表格", description: "读你能看到的电子表格和多维表格", scopes: ["sheets:spreadsheet:read", "sheets:spreadsheet.meta:read", "base:app:read", "base:table:read", "base:field:read", "base:record:read", "base:view:read"] },
    { id: "calendar", label: "日程", description: "读你的日程", scopes: ["calendar:calendar:read", "calendar:calendar.event:read"] },
    { id: "minutes", label: "妙记与会议", description: "读你的妙记，知道你加入了哪个会议", scopes: ["minutes:minutes:readonly", "minutes:minutes.artifacts:read", "vc:meeting.meetingevent:read"] },
    { id: "doc-write", label: "让助手写文档", description: "助手以你的身份新建、编辑文档（别人的文件先经你批准）", scopes: ["docx:document:write_only", "docx:document:create", "wiki:node:create", "wiki:node:move"] },
  ],
};

export const featuresOf = (provider: string) => FEATURES[provider] ?? [];

/** A plugin's provider brings its own features (src/plugins/registry.ts api.connector); gone with the plugin. */
export function registerFeatures(provider: string, list: Feature[]) {
  FEATURES[provider] = list;
  return () => {
    if (FEATURES[provider] === list) delete FEATURES[provider];
  };
}

/** The scopes to ask for to turn on these features (background access comes along with any of them). */
export function scopesFor(provider: string, ids: string[]) {
  const list = featuresOf(provider);
  const chosen = list.filter((f) => ids.includes(f.id));
  if (chosen.some((f) => f.id !== "offline")) chosen.push(...list.filter((f) => f.id === "offline"));
  return [...new Set(chosen.flatMap((f) => f.scopes))];
}

/** Features whose every scope the connection has. */
export function grantedFeatures(provider: string, scopes: string[]) {
  const have = new Set(scopes);
  return featuresOf(provider)
    .filter((f) => f.scopes.every((s) => have.has(s)))
    .map((f) => f.id);
}
