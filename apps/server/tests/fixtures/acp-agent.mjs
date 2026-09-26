// Protocol test double: not a production model and never enabled by default.
import readline from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let model = "alpha";
let effort = "low";
let promptId;
let permission = false;
const options = () => [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: model,
    options: [
      { value: "alpha", name: "Alpha" },
      { value: "beta", name: "Beta" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Effort",
    type: "select",
    currentValue: effort,
    options: [
      { value: "low", name: "Low" },
      ...(model === "beta" ? [{ value: "high", name: "High" }] : []),
    ],
  },
];
readline.createInterface({ input: process.stdin }).on("line", (raw) => {
  const msg = JSON.parse(raw);
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize")
    reply({
      protocolVersion: 1,
      agentInfo: { name: "test-fixture", version: "1" },
      agentCapabilities: {
        promptCapabilities: { image: true },
        sessionCapabilities: { close: {} },
      },
    });
  else if (msg.method === "session/new")
    reply({ sessionId: "test-session", configOptions: options() });
  else if (msg.method === "session/set_config_option") {
    if (msg.params.configId === "model") model = msg.params.value;
    else effort = msg.params.value;
    reply({ configOptions: options() });
  } else if (msg.method === "session/prompt") {
    promptId = msg.id;
    const text = msg.params.prompt
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (text.includes("TIMEOUT")) return;
    if (text.includes("ASK_PERMISSION")) {
      permission = true;
      send({
        jsonrpc: "2.0",
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: "test-session",
          toolCall: { toolCallId: "call-1", title: "Write protected file" },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject once", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "test-session",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "PRIVATE_THOUGHT" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "test-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Evidence answer ${model}/${effort}; images=${msg.params.prompt.filter((p) => p.type === "image").length}`,
          },
        },
      },
    });
    reply({ stopReason: "end_turn" });
  } else if (msg.method === "session/close") reply({});
  else if (msg.method === "session/cancel")
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
  else if (msg.id === "permission-1" && permission) {
    if (msg.result.outcome.outcome !== "cancelled") process.exit(8);
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "test-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Permission declined" },
        },
      },
    });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
