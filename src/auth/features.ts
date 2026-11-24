/**
 * What a person can turn on for a connected platform, and the scopes each asks for (docs/v2/multi-user.md,
 * “飞书提供方”). Feishu grants scopes incrementally: turning a feature on sends the person to the
 * authorization page with just its scopes, and the new token carries everything granted before. Scopes
 * must first be enabled for the app in the developer console (all of them, once); `offline_access` is
 * what lets omem keep working in the background (a refresh token).
 */
export type Feature = { id: string; label: string; description: string; scopes: string[]; requiredScopes?: string[] };

export const LARK_DOC_READ_SCOPE = "docx:document:readonly";
export const LARK_LEGACY_DOC_SCOPE = "docx:document";
export const LARK_LEGACY_WIKI_SCOPE = "wiki:wiki";
export const LARK_WIKI_COPY_SCOPE = "wiki:node:copy";
export const LARK_WIKI_NODE_READ = ["wiki:node:retrieve", "wiki:node:read", "wiki:wiki:readonly", LARK_LEGACY_WIKI_SCOPE];
export const LARK_WIKI_SPACE_READ = ["wiki:space:read", "wiki:wiki:readonly", LARK_LEGACY_WIKI_SCOPE];
// Existing connections with the original docs permissions and search can still capture recent docs.
const DOCS_REQUIRED_SCOPES = [LARK_DOC_READ_SCOPE, "docs:document.content:read", "wiki:node:read", "wiki:wiki:readonly", "drive:file:download", "search:docs:read"];

export const FEATURES: Record<string, Feature[]> = {
  lark: [
    { id: "offline", label: "后台访问", description: "omem 在你不在时也能读（刷新令牌）；采集类功能都要它", scopes: ["offline_access"] },
    // Granting lets the assistant read when you ask it to; nothing is saved until capture is turned on (the account page).
    {
      id: "messages",
      label: "群聊消息",
      description: "助手在你让它看时，以你的身份读你所在的群。默认不采集，要保存到 omem 在账号页打开采集",
      scopes: ["im:chat:read", "im:message:readonly", "im:message.group_msg:get_as_user", "im:resource", "contact:user.base:readonly"],
    },
    {
      id: "messages-p2p",
      label: "单聊消息",
      description: "助手在你让它看时，以你的身份读你的单聊。默认不采集，要保存到 omem 在账号页打开采集",
      scopes: ["im:chat:read", "im:message:readonly", "im:message.p2p_msg:get_as_user", "im:resource", "contact:user.base:readonly"],
    },
    {
      id: "docs", label: "文档与知识库",
      description: "搜索、读取你能看到的文档、附件和知识库。服务器开启最近文档采集时，最近打开的文档会收进你的个人空间",
      requiredScopes: DOCS_REQUIRED_SCOPES,
      scopes: [
        ...DOCS_REQUIRED_SCOPES,
        "wiki:node:retrieve", "wiki:space:retrieve", "wiki:space:read",
        "space:document:retrieve", "drive:drive.metadata:readonly",
        "docs:document.media:download", "board:whiteboard:node:read", "docs:permission.member:auth",
      ],
    },
    { id: "sheets", label: "表格与多维表格", description: "读你能看到的电子表格和多维表格", scopes: ["sheets:spreadsheet:read", "sheets:spreadsheet.meta:read", "base:app:read", "base:table:read", "base:field:read", "base:record:read", "base:view:read"] },
    { id: "calendar", label: "日程", description: "读你的日程", scopes: ["calendar:calendar:read", "calendar:calendar.event:read"] },
    { id: "minutes", label: "妙记与会议", description: "读你的妙记，知道你加入了哪个会议", scopes: ["minutes:minutes:readonly", "minutes:minutes.artifacts:read", "vc:meeting.meetingevent:read"] },
    {
      id: "doc-write", label: "让助手写文档",
      description: "以你的身份新建、编辑、移动和复制文档，含定位知识库和读取待编辑文档所需的权限（别人的文件先经你批准）",
      scopes: [
        LARK_DOC_READ_SCOPE, "wiki:node:read", "wiki:node:retrieve", "wiki:space:read", "drive:drive.metadata:readonly",
        "docx:document:create", "docx:document:write_only", "docs:document.media:upload",
        "wiki:node:create", "wiki:node:move", LARK_WIKI_COPY_SCOPE, "space:document:move",
      ],
    },
  ],
};

/** Which Feishu feature a lark-cli command family uses (one the account page can turn off). */
export const LARK_DOMAIN_FEATURES: Record<string, string> = { im: "messages", contact: "messages", docs: "docs", docx: "docs", wiki: "docs", drive: "docs", markdown: "docs", sheets: "sheets", base: "sheets", calendar: "calendar", minutes: "minutes", vc: "minutes" };
/** What a lark-cli call needs, to ask for when someone has not connected yet: a document write needs writing too. */
export function larkCommandFeatures(args: string[]): string[] {
  const f = LARK_DOMAIN_FEATURES[args[0] ?? ""];
  if (!f) return [];
  const write = f === "docs" && args.slice(1, 3).some((a) => /^\+?(?:node-)?(update|create|write|append|replace|insert|delete|move|copy|upload)/.test(a));
  return write ? ["doc-write"] : [f];
}

/** Plugin providers whose features follow the owner's settings (the scopes they filled in): read each time. */
const dynamic = new Map<string, () => Feature[]>();

/** A platform pack's own features replace what its catalog entry offers (src/plugins/platforms.ts). */
const packs = new Map<string, Feature[]>();

export const featuresOf = (provider: string) => packs.get(provider) ?? dynamic.get(provider)?.() ?? FEATURES[provider] ?? [];

export function overrideFeatures(provider: string, list: Feature[]) {
  packs.set(provider, list);
  return () => {
    if (packs.get(provider) === list) packs.delete(provider);
  };
}

/** A plugin's provider brings its own features (src/plugins/registry.ts api.connector); gone with the plugin. */
export function registerFeatures(provider: string, list: Feature[] | (() => Feature[])) {
  if (typeof list === "function") {
    dynamic.set(provider, list);
    return () => {
      if (dynamic.get(provider) === list) dynamic.delete(provider);
    };
  }
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

/** Features whose required scopes the connection has. Authorization can also request scopes for supporting operations. */
export function grantedFeatures(provider: string, scopes: string[]) {
  const have = new Set(scopes);
  return featuresOf(provider)
    .filter((f) => (f.requiredScopes ?? f.scopes).every((s) => have.has(s)))
    .map((f) => f.id);
}
