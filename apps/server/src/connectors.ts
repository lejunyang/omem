/** Connectors are explicit, bounded reads. URLs in captured text are retained, never
 * automatically crawled. Server filesystem imports require configured roots. */
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { CaptureInput } from "../../../packages/contracts/src/index.js";
const exec = promisify(execFile);
export async function allowedPath(path: string, roots: string[]) {
  const canonical = await realpath(resolve(path));
  for (const root of roots) {
    const base = await realpath(resolve(root));
    const r = relative(base, canonical);
    if (!r || (!r.startsWith("..") && !isAbsolute(r))) return canonical;
  }
  throw Error("Path is outside configured captureRoots");
}
export async function fileInput(
  path: string,
  roots: string[],
): Promise<CaptureInput> {
  const file = await allowedPath(path, roots);
  if ((await stat(file)).size > 500000) throw Error("Text file exceeds 500 KB");
  const bytes = await readFile(file);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw Error("Binary file is not plain text");
  return {
    source: "file",
    externalId: file,
    title: file.split("/").at(-1)!,
    parts: [{ type: "text", text }],
    context: {},
  };
}
export async function gitInput(
  repo: string,
  path: string,
  ref: string,
  roots: string[],
): Promise<CaptureInput> {
  const cwd = await allowedPath(repo, roots);
  if (
    !/^[a-zA-Z0-9_./-]+$/.test(ref) ||
    ref.startsWith("-") ||
    ref.includes("..")
  )
    throw Error("Invalid git ref");
  if (
    isAbsolute(path) ||
    path.split("/").includes("..") ||
    path.includes(":") ||
    path.startsWith("-")
  )
    throw Error("Invalid repository path");
  const { stdout: sha } = await exec(
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { cwd, timeout: 10000, maxBuffer: 10000 },
  );
  if (!/^[a-f0-9]{40,64}$/.test(sha.trim())) throw Error("Invalid commit");
  const { stdout: text } = await exec(
    "git",
    ["show", `${sha.trim()}:${path}`],
    { cwd, timeout: 15000, maxBuffer: 500000 },
  );
  return {
    source: "git",
    externalId: `${cwd}:${path}`,
    title: path,
    upstreamVersion: sha.trim(),
    parts: [{ type: "text", text }],
    context: {},
  };
}
export async function larkInput(url: string): Promise<CaptureInput> {
  const u = new URL(url);
  if (
    !/^\/(docx|wiki)\/[a-zA-Z0-9]+\/?$/.test(u.pathname) ||
    u.protocol !== "https:" ||
    u.username ||
    u.password
  )
    throw Error("Expected an HTTPS Lark docx/wiki URL");
  if (
    !["larkoffice.com", "feishu.cn", "larksuite.com"].some(
      (d) => u.hostname === d || u.hostname.endsWith("." + d),
    )
  )
    throw Error("Unsupported Lark document host");
  const { stdout } = await exec(
    "lark-cli",
    [
      "docs",
      "+fetch",
      "--doc",
      url,
      "--as",
      "user",
      "--doc-format",
      "markdown",
      "--detail",
      "with-ids",
    ],
    { timeout: 60000, maxBuffer: 2_000_000 },
  );
  const response = JSON.parse(stdout);
  if (!response.ok)
    throw Error("Lark fetch failed; check lark-cli authorization");
  const doc = response.data?.document;
  if (typeof doc?.content !== "string")
    throw Error("Lark response has no document content");
  // Keep the reference sidecar as source context, not executable markup or inferred links.
  return {
    source: "lark",
    externalId: doc.document_id || u.pathname,
    title:
      doc.content.match(/<title>(.*?)<\/title>/)?.[1] ||
      doc.content.split("\n")[0]?.slice(0, 200) ||
      "飞书文档",
    upstreamVersion: String(doc.revision_id ?? ""),
    parts: [
      { type: "text", text: doc.content },
      { type: "link", url, label: "飞书原文" },
      ...(doc.reference_map && Object.keys(doc.reference_map).length
        ? [
            {
              type: "text" as const,
              text: "来源引用元信息\n" + JSON.stringify(doc.reference_map),
            },
          ]
        : []),
    ],
    context: {},
  };
}
export type HookCaptureField =
  | "sessionId"
  | "turnId"
  | "toolName"
  | "prompt"
  | "toolInput"
  | "toolResponse"
  | "error";

export type HookCaptureProfile = {
  id: string;
  fields: readonly HookCaptureField[];
  maxChars: number;
};

export const defaultHookCaptureProfile: HookCaptureProfile = {
  id: "traex-default-v1",
  fields: [
    "sessionId",
    "turnId",
    "toolName",
    "prompt",
    "toolInput",
    "toolResponse",
    "error",
  ],
  maxChars: 200_000,
};

export function hookInput(
  value: unknown,
  profile: HookCaptureProfile = defaultHookCaptureProfile,
): CaptureInput {
  if (!value || typeof value !== "object")
    throw Error("Hook payload must be an object");
  const v = value as Record<string, unknown>;
  const event = String(v.hook_event_name || v.event_type || "unknown");
  // Explicit field selection excludes hidden thought/transcript dumps, credentials and unknown extensions.
  const available: Record<HookCaptureField, unknown> = {
    sessionId: v.session_id,
    turnId: v.turn_id,
    toolName: v.tool_name,
    prompt: v.prompt,
    toolInput: v.tool_input,
    toolResponse: v.tool_response,
    error: v.error,
  };
  const selected: Record<string, unknown> = { event, profile: profile.id };
  for (const field of profile.fields) selected[field] = available[field];
  const text = JSON.stringify(
    selected,
    (_k, val) =>
      typeof val === "string"
        ? val.replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
        : val,
    2,
  );
  if (text.length > profile.maxChars)
    throw Error("Hook payload exceeds capture profile budget");
  const explicitEventId = v.event_id ?? v.hook_id ?? v.message_id;
  const fallbackIdentity = [
    v.session_id,
    v.turn_id,
    v.tool_use_id,
    v.tool_call_id,
    v.tool_name,
    event,
    createHash("sha256").update(text).digest("hex"),
  ]
    .filter((part) => part !== undefined && part !== null && String(part))
    .map(String)
    .join(":");
  const eventId = String(
    explicitEventId ||
      createHash("sha256").update(fallbackIdentity).digest("hex"),
  ).slice(0, 500);
  const rawEventAt = v.event_at ?? v.timestamp;
  const eventAt =
    typeof rawEventAt === "string" && !Number.isNaN(Date.parse(rawEventAt))
      ? new Date(rawEventAt).toISOString()
      : null;
  return {
    source: "hook",
    externalId: `traex-hook:${eventId}`,
    title: `${event} · ${String(v.tool_name || "Agent 会话")}`,
    parts: [{ type: "text", text }],
    context: { event, runId: String(v.session_id || "unknown") },
    observedAt: eventAt ?? undefined,
    provenance: {
      collectorId: `traex-hook:${profile.id}`,
      actorId: null,
      actorType: "unknown",
      actorVerifiedBy: null,
      sourceUri: null,
      eventId,
      eventAt,
      timezone: null,
      quoted: false,
      forwarded: false,
      producerKind: "original",
    },
  };
}
