export type AgentEvent =
  | { type: "usage"; used: number; size: number }
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; id: string; title: string; kind?: string; status?: string; input?: unknown }
  | { type: "plan"; entries: { content: string; status: string }[] }
  | { type: "status"; text: string }
  // The agent session this turn runs in (known before the turn ends).
  | { type: "session"; sessionId: string; resumed: boolean }
  // Provider-side queue (traex session_info_update._meta.trae.queueStatus, or queue text).
  | { type: "queue"; queued: boolean; position?: number; message?: string };

export type McpAccess = {
  /** Streamable-HTTP endpoint for agents that support it. */
  url: string;
  /** API base for the stdio bridge. */
  baseUrl: string;
  token: string;
  stdio: { command: string; args: string[] };
  /** For the agent process: the token and an `omem` on PATH, so `omem tool` in its shell acts for this run. */
  env?: Record<string, string>;
};

export type AgentRequest = {
  cwd: string;
  /** This turn's text. */
  prompt: string;
  /**
   * Standing instructions (shared rules, role, environment, learned context). The agent's system
   * prompt when it takes one (ACP `systemPrompt`); otherwise the head of a new session's first
   * message. Never repeated into a resumed session.
   */
  system?: string;
  mcp?: McpAccess;
  /** Allow edit/delete/move tool kinds (coding in a worktree). */
  allowWrites?: boolean;
  /** Preferred session modes in order, e.g. ["read-only"] or ["acceptEdits", "auto"]. */
  modes?: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Only connect and report the agent's models/modes, no prompt. */
  probe?: boolean;
  strictSelection?: { model?: boolean; effort?: boolean };
  /** Extra MCP servers from an agent spec (stdio command or HTTP url). */
  extraMcp?: Record<string, { command: string; args: string[]; env: Record<string, string> } | { url: string; headers: Record<string, string> }>;
  /** CLI transports: keep the agent's own session on disk and/or continue one. */
  persistSession?: boolean;
  resumeSessionId?: string;
  /** Provider queue budget (ms); 0/undefined = unlimited while queued. */
  queueTimeoutMs?: number;
};

export type AgentProbe = {
  agent: string;
  modes: string[];
  options: { id: string; category: string | null; current: string | null; values: string[] }[];
  /** Effort levels per model: agents (traex) offer reasoning effort only once a model that has it is selected. */
  effortsByModel?: Record<string, string[]>;
};
/** Why a run failed; used to decide whether a fallback backend/model is worth trying. */
export type AgentFailureKind = "queue" | "idle" | "rate-limit" | "other";
export type AgentResult = {
  /** Latest measured context occupancy, not cumulative billed tokens. */
  contextUsage?: { used: number; size: number };
  /** Everything the agent said this turn, narration between tool calls included. */
  text: string;
  /** What it said after its last tool call: the reply to show (falls back to text). */
  reply?: string;
  stopReason: string;
  sessionId?: string;
  agent: string;
  probe?: AgentProbe;
};
/**
 * A turn's text for a session: the standing instructions go in front only in a new session that
 * did not take them as its system prompt. A resumed session already has them.
 */
export function withInstructions(session: { resumed: boolean; system?: boolean }, system: string | undefined, text: string) {
  return !system || session.resumed || session.system ? text : `${system}\n\n---\n\n${text}`;
}

/** The part of an agent's output meant as the answer. */
export const replyOf = (r: { text: string; reply?: string }) => (r.reply && r.reply.trim() ? r.reply : r.text);

/**
 * Agents narrate between tool calls ("我先核对…", "已查到…") and then write the answer. The
 * narration has been shown as live progress; the reply is the text after the last tool call.
 * A very short closing line after a final tool call ("已记下") keeps the segment before it.
 */
export function replyFromSegments(segments: string[]): string | undefined {
  const parts = segments.map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const last = parts[parts.length - 1];
  return last.length < 80 ? `${parts[parts.length - 2]}\n\n${last}` : last;
}
/** Error carrying a retryable classification (provider queue / rate limit / idle-after-queue). */
export function agentRunError(message: string, kind: AgentFailureKind, queued = false): Error & { kind: AgentFailureKind; queued: boolean } {
  const e = new Error(message) as Error & { kind: AgentFailureKind; queued: boolean; name: string };
  e.name = "AgentRunError";
  e.kind = kind;
  e.queued = queued;
  return e;
}
export function isAgentRunError(e: unknown): e is Error & { kind: AgentFailureKind; queued?: boolean } {
  return e instanceof Error && (e as { name?: string }).name === "AgentRunError";
}
