import type { ToolContext } from "./tools.ts";
import { all, one } from "../core/db.ts";
import { chatBinding } from "../core/capture-space.ts";
import { HttpError } from "../core/util.ts";
import { normalizeDocUrl } from "../channels/lark-docs.ts";

const denied = () => new HttpError(403, "飞书目标未归档或不在本次任务能读的空间内");
const unbounded = () => new HttpError(403, "无法确定本次飞书读取的范围。请指定已归档的文档链接、群或消息 ID");
const spaces = (ctx: ToolContext) => ctx.spaces ?? [ctx.spaceId];

/** Authorize the same canonical link that will be passed to the receiving device's CLI. */
export function boardLarkDocument(ctx: ToolContext, doc: string) {
  const link = URL.parse(doc);
  if (!link || link.protocol !== "https:" || link.port || link.username || link.password ||
      !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(link.hostname) ||
      !/^\/(docx|wiki|docs)\/[a-zA-Z0-9]+\/?$/.test(link.pathname)) throw unbounded();
  const { url, type, token } = normalizeDocUrl(link.href);
  // A document imported through /docx/ may have been filed under its /wiki/ link.
  const key = `lark:doc:${token}`;
  const target = type === "docx" ? "(uri=? or origin_key=? or origin_key glob ?)" : "uri=?";
  const keys = type === "docx" ? [url, key, key + "#*"] : [url];
  const known = one(ctx.app.db, `select 1 from sources where ${target} and kind='doc' and deleted_at is null
    and exists (select 1 from json_each(?) where value=space_id) limit 1`, ...keys, JSON.stringify(spaces(ctx)));
  if (!known) throw denied();
  return link.hash.startsWith("#share-") ? url + link.hash : url;
}

export function requireBoardLarkMessages(ctx: ToolContext, ids: string[]) {
  if (!ids.length || ids.length > 50 || !ids.every(id => /^om_[\w-]+$/.test(id))) throw unbounded();
  const found = one<{ space_id: string }>(ctx.app.db, `select min(s.space_id) space_id
    from lark_messages m left join lark_message_lines l on l.message_id=m.message_id
    join sources s on s.id=coalesce(l.source_id, m.source_id)
    where m.message_id in (select value from json_each(?)) and s.kind='chat' and s.deleted_at is null
    and s.space_id in (select value from json_each(?))
    having count(distinct m.message_id)=?`, JSON.stringify(ids), JSON.stringify(spaces(ctx)), new Set(ids).size);
  if (!found) throw denied();
  return found.space_id;
}

function requireBoardLarkChat(ctx: ToolContext, id: string) {
  if (!/^oc_[\w-]+$/.test(id)) throw unbounded();
  const bound = chatBinding(ctx.app, id);
  const allowed = spaces(ctx);
  // Listing live history is chat-wide. A month archived into another space makes it ambiguous.
  const uri = `lark:${id}`;
  const copies = all<{ space_id: string; current: number }>(ctx.app.db, `select space_id, max(uri=?) current from sources
    where (uri=? or uri glob ?) and kind='chat' and deleted_at is null group by space_id`, uri, uri, uri + "@*");
  if (!copies.length || copies.some(s => !allowed.includes(s.space_id))) throw denied();
  if (bound ? !allowed.includes(bound) : !copies.some(s => s.current)) throw denied();
}

/** Parse only options whose effect on the read scope we know. Rebuild argv so that both the
 * authorization check and the CLI see one unambiguous value per flag. */
function readFlags(command: string[], allowed: Record<string, RegExp>) {
  const flags: Record<string, RegExp> = { "--format": /^(json|markdown|text)$/, ...allowed };
  const args = new Map<string, string>();
  for (let i = 2; i < command.length; i++) {
    const arg = command[i];
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    if (!Object.hasOwn(flags, flag) || args.has(flag)) throw unbounded();
    const value = eq < 0 ? command[++i] : arg.slice(eq + 1);
    if (!value || !flags[flag].test(value)) throw unbounded();
    args.set(flag, value);
  }
  return args;
}

export function boardLarkCommand(ctx: ToolContext, command: string[], chatPages: Map<string, string>) {
  let args: Map<string, string>;
  let onNextPage: ((token: string) => void) | undefined;
  switch (command.slice(0, 2).join(" ")) {
    case "docs +fetch":
      args = readFlags(command, { "--doc": /^https:\/\//, "--doc-format": /^(xml|markdown)$/ });
      args.set("--doc", boardLarkDocument(ctx, args.get("--doc") ?? ""));
      break;
    case "im +chat-messages-list": {
      args = readFlags(command, { "--chat-id": /^oc_[\w-]+$/, "--page-size": /^\d{1,3}$/, "--order": /^(asc|desc)$/,
        "--start": /^[0-9T:.+Z-]+$/, "--end": /^[0-9T:.+Z-]+$/, "--page-token": /^(?!-)[^\s]+$/ });
      requireBoardLarkChat(ctx, args.get("--chat-id") ?? "");
      const query = Object.fromEntries(args);
      delete query["--page-token"];
      const queryKey = JSON.stringify(query, Object.keys(query).sort());
      const token = args.get("--page-token");
      if (token && chatPages.get(token) !== queryKey) throw unbounded();
      onNextPage = next => chatPages.set(next, queryKey);
      break;
    }
    case "im +messages-mget":
      args = readFlags(command, { "--message-ids": /^om_/ });
      requireBoardLarkMessages(ctx, (args.get("--message-ids") ?? "").split(","));
      break;
    case "im +messages-resources-download":
      args = readFlags(command, { "--message-id": /^om_[\w-]+$/, "--file-key": /^(file|img)_[\w-]+$/ });
      // messageFileText authorizes the message and the separately filed attachment.
      if (!args.has("--message-id")) throw unbounded();
      break;
    default: throw unbounded();
  }
  return { command: [...command.slice(0, 2), ...Array.from(args).flat()], onNextPage };
}
