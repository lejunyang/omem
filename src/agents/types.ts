export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; id: string; title: string; kind?: string; status?: string; input?: unknown }
  | { type: "plan"; entries: { content: string; status: string }[] }
  | { type: "status"; text: string }
  // Provider-side queue (trae queue_begin/queue_position/queue_end).
  | { type: "queue"; queued: boolean; position?: number; message?: string };

export type McpAccess = {
  /** Streamable-HTTP endpoint for agents that support it. */
  url: string;
  /** API base for the stdio bridge. */
  baseUrl: string;
  token: string;
  stdio: { command: string; args: string[] };
};

export type AgentRequest = {
  cwd: string;
  prompt: string;
  mcp?: McpAccess;
  /** Allow edit/delete/move tool kinds (coding in a worktree). */
  allowWrites?: boolean;
  /** Preferred session modes in order, e.g. ["read-only"] or ["acceptEdits", "auto"]. */
  modes?: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Only connect and report the agent's models/modes, no prompt. */
  probe?: boolean;
  /** Extra MCP servers from an agent spec (stdio command or HTTP url). */
  extraMcp?: Record<string, { command: string; args: string[]; env: Record<string, string> } | { url: string; headers: Record<string, string> }>;
  /** CLI transports: keep the agent's own session on disk and/or continue one. */
  persistSession?: boolean;
  resumeSessionId?: string;
  /** Provider queue budget (ms); 0/undefined = unlimited while queued. */
  queueTimeoutMs?: number;
};

export type AgentProbe = { agent: string; modes: string[]; options: { id: string; category: string | null; current: string | null; values: string[] }[] };
/** Why a run failed; used to decide whether a fallback backend/model is worth trying. */
export type AgentFailureKind = "queue" | "idle" | "rate-limit" | "other";
export type AgentResult = { text: string; stopReason: string; sessionId?: string; agent: string; probe?: AgentProbe };
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
