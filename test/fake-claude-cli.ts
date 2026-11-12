// Prints `claude -p --output-format stream-json` lines for a turn with thinking, one tool call and its result.
const lines = [
  { type: "system", subtype: "init", session_id: "c-1" },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "先看文件" }, { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "a.ts" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "…", is_error: false }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: { command: "false" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "exit 1", is_error: true }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
  { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "c-1" },
];
process.stdin.resume();
process.stdin.on("end", () => { for (const l of lines) console.log(JSON.stringify(l)); });
