export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; id: string; title: string; kind?: string; status?: string; input?: unknown }
  | { type: "plan"; entries: { content: string; status: string }[] }
  | { type: "status"; text: string };

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
};

export type AgentResult = { text: string; stopReason: string; sessionId?: string; agent: string };
