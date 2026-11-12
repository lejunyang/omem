// Prints what `codex exec --json` printed for a small real turn (0.164), plus a reasoning summary and a failed command.
const lines = [
  { type: "thread.started", thread_id: "t-1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "先跑一下命令" } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "I’ll run the command once." } },
  { type: "item.started", item: { id: "item_2", type: "command_execution", command: "echo hi", aggregated_output: "", exit_code: null, status: "in_progress" } },
  { type: "item.completed", item: { id: "item_2", type: "command_execution", command: "echo hi", aggregated_output: "hi\n", exit_code: 0, status: "completed" } },
  { type: "item.started", item: { id: "item_3", type: "mcp_tool_call", server: "omem", tool: "search", status: "in_progress" } },
  { type: "item.completed", item: { id: "item_3", type: "mcp_tool_call", server: "omem", tool: "search", status: "failed" } },
  { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "ok" } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
];
process.stdin.resume();
process.stdin.on("end", () => { for (const l of lines) console.log(JSON.stringify(l)); });
