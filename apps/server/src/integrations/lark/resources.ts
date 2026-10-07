import { Client, Domain } from "@larksuiteoapi/node-sdk";
import type { Store } from "../../store.js";
import type { EncryptedSecretStore } from "./secret-store.js";
import type { CaptureInput } from "../../../../../packages/contracts/src/index.js";
import { saveImportAsset } from "../../imports/documents.js";

export interface LarkResourcePort {
  resource(
    appId: string,
    messageId: string,
    key: string,
    type: "image" | "file",
  ): Promise<Buffer>;
  document?(appId: string, uri: string): Promise<CaptureInput>;
}
/** Read only, using the app that received the event, never the owner's private credentials. */
export class OfficialLarkResourcePort implements LarkResourcePort {
  constructor(
    private store: Store,
    private secrets: EncryptedSecretStore,
  ) {}
  private client(appId: string) {
    const row = this.store.db
      .prepare(
        `SELECT c.tenant_brand,v.secret_ref FROM lark_connections c
      JOIN lark_connection_versions v ON v.connection_id=c.id AND v.version=c.active_version
      WHERE c.app_id=? AND c.state='active'`,
      )
      .get(appId);
    if (!row) throw Error("机器人连接不可用，原消息已保留");
    const secret = this.secrets.get(String(row.secret_ref));
    return {
      secret,
      client: new Client({
        appId,
        appSecret: secret.clientSecret,
        domain: row.tenant_brand === "lark" ? Domain.Lark : Domain.Feishu,
      }),
    };
  }
  async resource(
    appId: string,
    messageId: string,
    key: string,
    type: "image" | "file",
  ) {
    const { client, secret } = this.client(appId);
    try {
      const response = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: key },
        params: { type },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.getReadableStream()) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 20_000_000) throw Error("附件超过20 MB，请拆分后导入");
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      throw Error(
        (error instanceof Error ? error.message : "机器人资源读取失败")
          .replaceAll(secret.clientSecret, "[REDACTED]")
          .replace(/[\r\n]+/g, " ")
          .slice(0, 500),
      );
    }
  }
  async document(appId: string, uri: string): Promise<CaptureInput> {
    const url = new URL(uri);
    const match = url.pathname.match(/^\/(docx|wiki)\/([A-Za-z0-9]+)\/?$/);
    if (
      !match ||
      url.protocol !== "https:" ||
      !/(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(url.hostname)
    )
      throw Error("不是支持的飞书文档链接");
    const { client, secret } = this.client(appId);
    try {
      const node =
        match[1] === "wiki"
          ? await client.wiki.space.getNode({
              params: { token: match[2]!, obj_type: "wiki" },
            })
          : null;
      if (node?.code || (node && node.data?.node?.obj_type !== "docx"))
        throw Error(node?.msg ?? "此知识库节点不是可读取的docx文档");
      const documentId = node?.data?.node?.obj_token ?? match[2]!;
      const metadata = await client.docx.document.get({
        path: { document_id: documentId },
      });
      if (metadata.code) throw Error(metadata.msg ?? "文档元数据读取失败");
      const response = await client.docx.document.rawContent({
        path: { document_id: documentId },
      });
      if (response.code || !response.data?.content?.trim())
        throw Error(response.msg ?? "文档正文不可用");
      const originalAssetId = await saveImportAsset(
        this.store.dataDir,
        Buffer.from(JSON.stringify({ node, metadata, response })),
      );
      return {
        source: "lark",
        externalId: `lark-bot:${appId}:${documentId}`,
        title:
          metadata.data?.document?.title ??
          node?.data?.node?.title ??
          "飞书文档",
        upstreamVersion: String(metadata.data?.document?.revision_id ?? ""),
        parts: [
          { type: "text", text: response.data.content },
          { type: "link", url: uri, label: "飞书原文" },
        ],
        context: {
          document: {
            parser: "lark-api",
            parserVersion: "1.74.0",
            originalAssetId,
            structureAssetId: originalAssetId,
            originalName: "飞书文档原始响应.json",
            mimeType: "application/json",
            pageCount: 0,
            warnings: ["机器人应用读取纯文本；内嵌表格、画板和图片尚未展开"],
          },
        },
      };
    } catch (error) {
      throw Error(
        (error instanceof Error ? error.message : "机器人文档读取失败")
          .replaceAll(secret.clientSecret, "[REDACTED]")
          .slice(0, 500),
      );
    }
  }
}
