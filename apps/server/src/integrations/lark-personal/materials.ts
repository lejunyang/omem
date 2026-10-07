import { LarkResourceCache } from "./cache.js";
import { extname } from "node:path";
import {
  captureSchema,
  type CaptureInput,
} from "../../../../../packages/contracts/src/index.js";
import type { Store } from "../../store.js";
import { documentInput, saveImportAsset } from "../../imports/documents.js";
import { larkInput } from "../../connectors.js";
import type { LarkMessage, PersonalLarkPort } from "./client.js";
export type MessageResource = {
  kind: string;
  label: string;
  uri?: string;
  key?: string;
  assetId?: string;
  revisionId?: string;
  cached?: boolean;
  document?: CaptureInput["context"]["document"];
  status: "read" | "saved" | "failed";
  error?: string;
};
export type MessageMaterialOptions = {
  mode?: "remote" | "saved" | "capture";
  savedResources?: MessageResource[];
  rawAssetId?: string;
  readDocument?: (uri: string) => Promise<CaptureInput>;
  onResource?: (resource: MessageResource) => void;
};
export function messageTime(value: string) {
  const n = Number(value);
  const date = new Date(Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : value);
  if (isNaN(date.getTime())) throw Error("消息缺少有效时间");
  return date.toISOString();
}
export function resourcesIn(content: string) {
  const urls = [
    ...new Set(content.match(/https:\/\/[^\s<>"')]+/g) ?? []),
  ].filter((url) => {
    try {
      const u = new URL(url);
      return (
        /(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(u.hostname) &&
        /^\/(docx|wiki)\/[A-Za-z0-9]+/.test(u.pathname)
      );
    } catch {
      return false;
    }
  });
  const keys = [
    ...new Set(content.match(/\b(?:img|file)_[A-Za-z0-9_-]+/g) ?? []),
  ];
  return { urls, keys };
}
export async function messageMaterial(
  store: Store,
  port: Pick<PersonalLarkPort, "resource">,
  message: LarkMessage,
  name: string,
  ownerId: string,
  readResources: boolean,
  refresh = false,
  ensureActive: () => void = () => {},
  options: MessageMaterialOptions = {},
) {
  ensureActive();
  const cache = new LarkResourceCache(store);
  const content =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  const observedAt = messageTime(message.create_time);
  const who = message.sender?.name || "发言人";
  const parts: CaptureInput["parts"] = [
    {
      type: "text",
      text: `${who} · ${observedAt}\n${message.deleted ? "此消息已撤回" : content || "（无文字内容）"}`,
    },
  ];
  const resources: MessageResource[] = [];
  if (!message.deleted) {
    const found = resourcesIn(content);
    for (const uri of found.urls) {
      ensureActive();
      const resource: MessageResource = {
        kind: "document",
        label: "飞书文档",
        uri,
        status: "saved",
      };
      resources.push(resource);
      if (!readResources) continue;
      try {
        const cacheKey = `document:${ownerId}:${uri}`;
        const stored = options.savedResources?.find(
          (r) => r.kind === "document" && r.uri === uri,
        );
        const useSaved =
          options.mode === "saved" ||
          (options.mode === "capture" &&
            Boolean(stored?.revisionId || stored?.assetId));
        const cached =
          !useSaved && !refresh && cache.get<{ revisionId: string }>(cacheKey);
        const previous = cached && store.revision(cached.revisionId);
        if (previous && previous.current) {
          const restored: CaptureInput["parts"] = previous.parts.map((part) => {
            if (part.type !== "image") return part;
            const bytes = store.asset(part.assetId);
            if (!bytes)
              throw Error("缓存文档的图片不可用，请挂载冷存储或重新读取");
            const { assetId, ...image } = part;
            return captureSchema.shape.parts.element.parse({
              ...image,
              data: bytes.toString("base64"),
            });
          });
          resource.revisionId = previous.id;
          resource.assetId = previous.context.document?.originalAssetId;
          resource.document = previous.context.document;
          resource.label = previous.title;
          resource.status = "read";
          resource.cached = true;
          parts.push(
            { type: "text", text: `关联文档「${previous.title}」` },
            ...restored,
          );
          continue;
        }
        let input: CaptureInput;
        if (useSaved) {
          const revision =
            stored?.revisionId && store.revision(stored.revisionId);
          const document =
            stored?.document ?? (revision && revision.context.document);
          if (document && ["lark-cli", "lark-api"].includes(document.parser)) {
            const assetId = stored?.assetId ?? document.originalAssetId;
            const raw = JSON.parse(
              requiredAsset(store, assetId).toString("utf8"),
            );
            const content =
              document.parser === "lark-cli"
                ? raw.data?.document?.content
                : raw.response?.data?.content;
            if (typeof content !== "string" || !content.trim())
              throw Error("保存的飞书文档响应缺少正文，不能重新解析");
            input = captureSchema.parse({
              source: "lark",
              externalId: uri,
              title: revision ? revision.title : stored!.label,
              parts: [
                { type: "text", text: content },
                { type: "link", url: uri, label: "飞书原文" },
              ],
              context: { ...(revision ? revision.context : {}), document },
            });
            resource.assetId = assetId;
            resource.document = document;
          } else {
            if (!revision)
              throw Error("此文档尚无保存原件；需要明确重新读取远端");
            input = captureSchema.parse({
              source: revision.source,
              externalId: uri,
              title: revision.title,
              parts: revision.parts.map((p) =>
                p.type === "image"
                  ? {
                      type: "image",
                      data: requiredAsset(store, p.assetId).toString("base64"),
                      mimeType: p.mimeType,
                      label: p.label,
                    }
                  : p,
              ),
              context: revision.context,
            });
          }
          resource.revisionId = revision ? revision.id : undefined;
          resource.label = input.title;
          resource.status = "read";
          parts.push(
            { type: "text", text: `关联文档「${input.title}」` },
            ...input.parts,
          );
          continue;
        }
        input = await (
          options.readDocument ?? ((url) => larkInput(url, store.dataDir))
        )(uri);
        resource.assetId = input.context.document?.originalAssetId;
        resource.document = input.context.document;
        ensureActive();
        const captured = store.capture(input, {
          learning: false,
          notify: false,
        });
        cache.put(cacheKey, { revisionId: captured.revision.id }, 10 * 60_000);
        resource.revisionId = captured.revision.id;
        resource.assetId = input.context.document?.originalAssetId;
        resource.label = input.title;
        resource.status = "read";
        parts.push(
          { type: "text", text: `关联文档「${input.title}」` },
          ...input.parts,
        );
      } catch (e) {
        resource.status = "failed";
        resource.error = e instanceof Error ? e.message : "文档读取失败";
      } finally {
        options.onResource?.(resource);
      }
    }
    for (const key of found.keys) {
      ensureActive();
      const kind = key.startsWith("img_") ? "image" : "file";
      const nameMatch = content.match(
        new RegExp(`<file[^>]*key=["']${key}["'][^>]*name=["']([^"']+)`),
      );
      const label =
        nameMatch?.[1] ||
        jsonFileName(content, key) ||
        (kind === "image" ? "消息图片" : "消息附件");
      const resource: MessageResource = { kind, key, label, status: "saved" };
      resources.push(resource);
      if (!readResources) continue;
      try {
        const cacheKey = `resource:${ownerId}:${kind}:${key}`;
        const stored = options.savedResources?.find(
          (r) =>
            r.key === key || (!r.key && r.kind === kind && r.label === label),
        );
        const cached =
          options.mode === "saved" ||
          (options.mode === "capture" && stored?.assetId)
            ? stored?.assetId
              ? { assetId: stored.assetId }
              : null
            : !refresh && cache.get<{ assetId: string }>(cacheKey);
        const local = cached ? store.asset(cached.assetId) : null;
        if (options.mode === "saved" && !local)
          throw Error("此附件尚无保存原件；需要明确重新读取远端");
        const bytes =
          local ?? (await port.resource(message.message_id, key, kind));
        ensureActive();
        resource.cached = !!local;
        resource.assetId =
          local && cached
            ? cached.assetId
            : await saveImportAsset(store.dataDir, bytes);
        ensureActive();
        cache.put(
          cacheKey,
          { assetId: resource.assetId },
          30 * 24 * 60 * 60_000,
        );
        const mime = bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? "image/png"
          : bytes[0] === 255 && bytes[1] === 216
            ? "image/jpeg"
            : bytes.toString("ascii", 0, 4) === "RIFF" &&
                bytes.toString("ascii", 8, 12) === "WEBP"
              ? "image/webp"
              : null;
        if (mime && bytes.length <= 5_000_000) {
          parts.push({
            type: "image",
            mimeType: mime,
            data: bytes.toString("base64"),
            label,
          });
        } else if ([".pdf", ".docx"].includes(extname(label).toLowerCase())) {
          const input = await documentInput(
            bytes,
            label,
            store.dataDir,
            `lark-attachment:${message.message_id}:${key}`,
          );
          ensureActive();
          const captured = store.capture(input, {
            learning: false,
            notify: false,
          });
          resource.revisionId = captured.revision.id;
          resource.status = "read";
          parts.push(
            { type: "text", text: `附件「${label}」` },
            ...input.parts,
          );
        } else if (
          /\.(txt|md|csv|json|log)$/i.test(label) &&
          bytes.length <= 200_000
        ) {
          parts.push({
            type: "text",
            text: `附件「${label}」\n${bytes.toString("utf8")}`,
          });
          resource.status = "read";
        }
        // Images are saved for the vision-capable ACP agent, never declared understood by a text-only classifier.
      } catch (e) {
        resource.status = "failed";
        resource.error = e instanceof Error ? e.message : "资源读取失败";
      } finally {
        options.onResource?.(resource);
      }
    }
  }
  if (parts.length > 50)
    throw Error("消息资源过多，需要分批读取，原始消息仍保留");
  ensureActive();
  const rawAssetId =
    options.rawAssetId ??
    (await saveImportAsset(
      store.dataDir,
      Buffer.from(JSON.stringify(message)),
    ));
  ensureActive();
  const input: CaptureInput = {
    source: "chat",
    externalId: `lark-personal:${message.message_id}`,
    title: `${name} · ${who}`.slice(0, 300),
    observedAt,
    parts,
    context: {
      application: "飞书",
      conversationId: message.chat_id,
      chat: {
        messageId: message.message_id,
        threadId: message.thread_id,
        rawAssetId,
        resources: resources.map(
          ({ key, cached, document, ...resource }) => resource,
        ),
      },
    },
    provenance: {
      collectorId: "lark-personal",
      actorId: message.sender?.id ?? null,
      actorType:
        message.sender?.id === ownerId
          ? "owner"
          : message.sender?.sender_type === "app"
            ? "bot"
            : "user",
      actorVerifiedBy: "lark-cli",
      sourceUri: message.message_app_link ?? null,
      eventId: null,
      eventAt: observedAt,
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original",
      actorExternalId: message.sender?.id ?? null,
      actorPrincipalId: message.sender?.id === ownerId ? "owner" : null,
    },
  };
  return { input, resources };
}
function requiredAsset(store: Store, id: string) {
  const bytes = store.asset(id);
  if (!bytes) throw Error("保存的原件不可用，请挂载冷存储或恢复备份");
  return bytes;
}
function jsonFileName(content: string, key: string): string | null {
  try {
    const value = JSON.parse(content);
    if (value.file_key === key && typeof value.file_name === "string")
      return value.file_name;
  } catch {
    /* The CLI can return rich HTML rather than JSON. */
  }
  return null;
}
