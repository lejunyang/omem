import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { App } from "./core/app.ts";
import { listSpaces } from "./core/spaces.ts";
import { sha256, truncate } from "./core/util.ts";
import { upsertSource } from "./sources/store.ts";

/**
 * Capture coding-agent sessions as personal experience. Wire it as a Claude
 * Code `Stop` hook or a Codex `notify` program; each session becomes one chat
 * source in the space whose directory contains the session's cwd.
 */
type Turn = { role: "user" | "assistant"; text: string; at?: string };

function spaceForCwd(app: App, cwd?: string) {
  if (cwd) {
    const target = resolve(cwd) + sep;
    const match = listSpaces(app)
      .filter((s) => s.rootPath && target.startsWith(resolve(s.rootPath) + sep))
      .sort((a, b) => b.rootPath!.length - a.rootPath!.length)[0];
    if (match) return match.id;
  }
  return "personal";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");
  return "";
}

/** Claude Code transcript JSONL → user/assistant text turns (tool calls and results are skipped). */
export function claudeTranscript(path: string): Turn[] {
  if (!existsSync(path)) return [];
  const turns: Turn[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string; isMeta?: boolean };
      if ((e.type !== "user" && e.type !== "assistant") || e.isMeta) continue;
      const text = textOf(e.message?.content).trim();
      if (!text || text.startsWith("<command-") || text.startsWith("<local-command")) continue;
      turns.push({ role: e.type, text, at: e.timestamp });
    } catch {}
  }
  return turns;
}

function render(turns: Turn[]) {
  return turns.map((t) => `**${t.role === "user" ? "本人" : "Agent"}**${t.at ? `（${t.at.slice(0, 16).replace("T", " ")}）` : ""}：${truncate(t.text, 4000)}`).join("\n\n");
}

export function captureClaudeHook(app: App, payload: { session_id?: string; transcript_path?: string; cwd?: string }) {
  if (!payload.transcript_path || !payload.session_id) return null;
  const turns = claudeTranscript(payload.transcript_path);
  if (!turns.some((t) => t.role === "user")) return null;
  const first = turns.find((t) => t.role === "user")!.text;
  return upsertSource(app, {
    spaceId: spaceForCwd(app, payload.cwd),
    kind: "chat",
    uri: `agent:claude:${payload.session_id}`,
    title: `Claude Code：${truncate(first.replace(/\s+/g, " "), 50)}`,
    text: render(turns),
    meta: { agent: "claude-code", cwd: payload.cwd, sessionId: payload.session_id },
  });
}

/** Codex `notify` passes one JSON argument per completed turn; turns are appended per working directory and day. */
export function captureCodexNotify(app: App, payload: { type?: string; cwd?: string; "input-messages"?: string[]; "last-assistant-message"?: string; "thread-id"?: string }) {
  if (payload.type !== "agent-turn-complete") return null;
  const spaceId = spaceForCwd(app, payload.cwd);
  const day = new Date().toISOString().slice(0, 10);
  const key = payload["thread-id"] ?? `${sha256(payload.cwd ?? "").slice(0, 10)}:${day}`;
  const at = new Date().toISOString();
  const turns: Turn[] = [...(payload["input-messages"] ?? []).map((text) => ({ role: "user" as const, text, at })), ...(payload["last-assistant-message"] ? [{ role: "assistant" as const, text: payload["last-assistant-message"], at }] : [])];
  if (!turns.length) return null;
  const uri = `agent:codex:${key}`;
  const prev = app.db.prepare("select text from sources where space_id = ? and uri = ? and deleted_at is null").get(spaceId, uri) as { text: string } | undefined;
  return upsertSource(app, {
    spaceId,
    kind: "chat",
    uri,
    title: `Codex：${truncate((payload["input-messages"]?.[0] ?? "会话").replace(/\s+/g, " "), 50)}`,
    text: [prev?.text, render(turns)].filter(Boolean).join("\n\n"),
    meta: { agent: "codex", cwd: payload.cwd },
  });
}
