import { larkCli } from "./lark-cli.ts";

/** Read a Feishu/Lark docx or wiki page as Markdown through the official CLI (user identity). */
export async function readLarkDocument(url: string): Promise<{ title: string; markdown: string; revision: string }> {
  const u = new URL(url);
  if (!/^\/(docx|wiki|docs)\/[A-Za-z0-9]+/.test(u.pathname)) throw new Error("只支持飞书 docx / wiki 文档链接");
  const response = await larkCli(["docs", "+fetch", "--doc", url, "--as", "user", "--doc-format", "markdown"], 60_000);
  const doc = response.data?.document;
  if (typeof doc?.content !== "string") throw new Error("飞书返回内容为空");
  const content: string = doc.content;
  const title = content.match(/<title>(.*?)<\/title>/)?.[1] || content.split("\n").find((l: string) => l.trim())?.replace(/^#+\s*/, "").slice(0, 120) || "飞书文档";
  return { title, markdown: content.replace(/<title>.*?<\/title>\n?/, ""), revision: String(doc.revision_id ?? "") };
}
