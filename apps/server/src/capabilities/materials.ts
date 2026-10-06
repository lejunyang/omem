import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import { captureSchema } from "../../../../packages/contracts/src/index.js";
import type { Store } from "../store.js";
import { stableDigest } from "../storage/digest.js";
import { saveImportAssetSync } from "../imports/documents.js";
import { materialFromRevision } from "../knowledge/repository.js";
import { codePath } from "../development/workspace.js";
import type { CapabilityReceipt } from "./receipts.js";

/** A tool response is an observed source, not a model's assertion of a fact.
 * Save only selected reusable inputs; errors and availability probes remain receipts. */
export function captureCapabilityMaterial(
  store: Store,
  directory: string,
  receipt: CapabilityReceipt,
  selection: { title: string; contextIds?: string[] },
) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS capability_material_receipts(
    record_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const saved = store.db
    .prepare(
      "SELECT revision_id FROM capability_material_receipts WHERE record_id=?",
    )
    .get(receipt.recordId);
  const resultMaterial = (revisionId: string) => {
    const material = materialFromRevision(store, revisionId);
    if (!material) throw Error("已捕获的外部材料版本缺失");
    if (selection.contextIds?.length)
      store.setSourceContexts(material.sourceId, [
        ...new Set([
          ...store.contexts.forSource(material.sourceId),
          ...selection.contextIds,
        ]),
      ]);
    return material;
  };
  if (saved) return resultMaterial(String(saved.revision_id));
  const result = receipt.result as Record<string, any> | null;
  if (!result || result.isError || result.exitCode)
    throw Error("读取失败的回执不能保存为材料；请先处理登录、权限或读取错误");
  const parts: CaptureInput["parts"] = [],
    warnings: string[] = [];
  const text = (value: string) => {
    if (!value.trim()) return;
    // Preserve Markdown verbatim; these pieces are storage limits, not chapters.
    for (let offset = 0; offset < value.length; offset += 200000)
      parts.push({ type: "text", text: value.slice(offset, offset + 200000) });
  };
  const raw = structuredClone(result);
  if (receipt.kind === "cli") text(String(result.stdout ?? ""));
  else {
    for (const block of (raw.content ?? []) as Record<string, any>[]) {
      if (block.type === "text") text(String(block.text ?? ""));
      else if (
        block.type === "resource" &&
        typeof block.resource?.text === "string"
      ) {
        text(block.resource.text);
      } else if (block.type === "image_file") {
        const path = String(block.path),
          name = basename(path);
        if (!name.startsWith(receipt.recordId + "-"))
          throw Error("图片不属于所选回执");
        const bytes = readFileSync(
          codePath(directory, relative(directory, path)),
        );
        block.assetId = saveImportAssetSync(store.dataDir, bytes);
        delete block.path;
        if (
          ["image/png", "image/jpeg", "image/webp"].includes(block.mimeType) &&
          bytes.length <= 5_000_000
        )
          parts.push({
            type: "image",
            mimeType: block.mimeType,
            data: bytes.toString("base64"),
            label: "外部材料图片",
          });
        else warnings.push(`图片已存原件，当前阅读器不支持此格式或大小`);
      } else if (
        block.type === "resource_link" &&
        /^https?:\/\//.test(String(block.uri))
      ) {
        parts.push({
          type: "link",
          url: block.uri,
          label: String(block.title ?? block.name ?? "相关资源").slice(0, 300),
        });
      } else
        warnings.push(
          `已保留 ${String(block.type)} 原始结果，未自动解析或读取链接`,
        );
    }
    if (result.structuredContent) {
      // MCP may return a brief status in content and the actual document here.
      const structured = JSON.stringify(result.structuredContent, null, 2);
      const alreadyPresent = parts.some((p) => {
        if (p.type !== "text") return false;
        try {
          return (
            stableDigest(JSON.parse(p.text)) ===
            stableDigest(result.structuredContent)
          );
        } catch {
          return false;
        }
      });
      if (!alreadyPresent) text(structured);
    }
  }
  if (!parts.some((p) => p.type === "text" || p.type === "image"))
    throw Error("这份回执只有定位信息，没有可保存的正文或图片；先读取具体内容");
  const externalId = `capability:${stableDigest({ capability: receipt.capability, kind: receipt.kind, tool: receipt.tool, args: receipt.args })}`;
  // Compare response content, not timestamps/receipt IDs/temporary image paths.
  const responseDigest = stableDigest({ parts, warnings });
  const head = store.db
    .prepare(
      "SELECT r.id,r.body FROM sources s JOIN revisions r ON r.id=s.head WHERE s.namespace='hook' AND s.external_id=?",
    )
    .get(externalId);
  let revisionId: string;
  if (
    head &&
    JSON.parse(String(head.body)).context?.externalTool?.responseDigest ===
      responseDigest
  ) {
    revisionId = String(head.id);
  } else {
    const rawAssetId = saveImportAssetSync(
      store.dataDir,
      Buffer.from(JSON.stringify({ ...receipt, result: raw })),
    );
    const input = captureSchema.parse({
      source: "hook",
      externalId,
      title: selection.title,
      parts,
      context: {
        application: "omem.capability",
        externalTool: {
          capability: receipt.capability,
          kind: receipt.kind,
          tool: receipt.tool,
          responseDigest,
          rawAssetId,
          warnings,
        },
      },
      provenance: {
        collectorId: "omem.capability",
        actorId: null,
        actorType: "unknown",
        actorVerifiedBy: null,
        sourceUri: null,
        eventId: receipt.recordId,
        eventAt: receipt.finishedAt,
        timezone: null,
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    });
    revisionId = store.capture(input, { notify: false }).revision.id;
  }
  store.db
    .prepare("INSERT OR IGNORE INTO capability_material_receipts VALUES(?,?,?)")
    .run(receipt.recordId, revisionId, receipt.finishedAt);
  return resultMaterial(revisionId);
}
