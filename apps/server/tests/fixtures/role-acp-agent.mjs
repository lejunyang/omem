// Deterministic ACP protocol fixture for role-runtime tests. It is never a production model.
import readline from "node:readline";

const args = new Set(process.argv.slice(2));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sessionId = `role-session-${process.pid}`;
let model = "alpha";
let effort = "low";
let pendingPrompt;
let pendingText = "";
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
const update = (value) =>
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
const field = (text, name, fallback) =>
  text.match(new RegExp(`"${name}":"([^"]+)"`))?.[1] || fallback;
const lastField = (text, name, fallback) =>
  [...text.matchAll(new RegExp(`"${name}":"([^"]+)"`, "g"))].at(-1)?.[1] ||
  fallback;
function output(text) {
  const jobId = lastField(text, "job_id", "fixture-job");
  const roleId = field(text, "role_id", "extractor");
  const projectId = field(text, "project_id", "none");
  const imageCount = (pendingText.match(/"asset_hash"/g) || []).length;
  if (text.includes("OUTPUT_FLOOD")) return "x".repeat(20_000);
  if (text.includes("MALFORMED_OUTPUT")) return "not-json";
  if (roleId === "verifier") {
    if (text.includes("PIPELINE_TASK"))
      return JSON.stringify({
        schema_version: 1,
        job_id: jobId,
        role_id: "verifier",
        assessments: [
          {
            proposal_id: field(text, "proposal_id", "missing-proposal"),
            proposal_digest: field(text, "proposal_digest", "0".repeat(64)),
            quote_asset_verdict: "valid",
            semantic_verdict: "supported",
            reason_code: "fixture_direct_support",
            reason: "The exact fixed evidence supports the test proposal.",
            missing_context: [],
          },
        ],
      });
    return JSON.stringify({
      schema_version: 1,
      job_id: jobId,
      role_id: "verifier",
      assessments: [],
    });
  }
  if (roleId === "planner")
    return JSON.stringify({
      schema_version: 1,
      proposal_id: "plan-1",
      task_id: "task-1",
      expected_version: 1,
      steps: [
        {
          action: "gather_context",
          evidence_refs: ["fragment-1"],
          expected_output: "bounded context",
          verification: "source remains fixed",
          needs_owner_decision: false,
          stop_condition: "context is available",
        },
      ],
      uncertainties: [],
      origin: {
        job_id: jobId,
        role_bundle: "planner@1",
        producer_kind: "derived",
      },
    });
  if (roleId === "feedback-curator")
    return JSON.stringify({
      schema_version: 1,
      correction_id: "correction-1",
      target: { type: "task", id: "task-1", expected_version: 1 },
      scope: {
        workspace_id: "personal",
        project_id: projectId === "none" ? null : projectId,
        subject_id: "owner",
      },
      stop_using: "old owner",
      replacement: "new owner",
      evidence: [
        {
          fragment_revision_id: "fragment-1",
          source_revision_id: "source-1",
          exact_quote: "corrected",
          selector: { start: 0, end: 9, unit: "unicode_codepoint" },
        },
      ],
      reason: "authenticated correction",
      origin: {
        job_id: jobId,
        role_bundle: "feedback-curator@1",
        producer_kind: "derived",
      },
    });
  if (text.includes("PIPELINE_TASK"))
    return JSON.stringify({
      schema_version: 1,
      job_id: jobId,
      role_id: "extractor",
      observations: [],
      proposals: [
        {
          schema_version: 1,
          proposal_id: "fixture-pipeline-proposal",
          kind: "task",
          operation: "create",
          scope: {
            workspace_id: "personal",
            project_id: projectId === "none" ? null : projectId,
            subject_id: "owner",
          },
          body: {
            title: "完成受控 worker 集成",
            owner_id: "owner",
            due_at: null,
            due_expression: null,
            next_step: "核对持久回执",
          },
          evidence: [
            {
              fragment_revision_id: field(
                text,
                "fragment_revision_id",
                "missing-fragment",
              ),
              source_revision_id: field(
                text,
                "source_revision_id",
                "missing-revision",
              ),
              exact_quote: "PIPELINE_TASK",
              selector: {
                start: 0,
                end: 13,
                unit: "unicode_codepoint",
              },
            },
          ],
          uncertainties: [],
          reason: "Verified owner supplied an explicit task.",
          expected_versions: {},
          origin: {
            job_id: jobId,
            role_bundle: "extractor@1",
            producer_kind: "derived",
          },
        },
      ],
      abstentions: [],
    });
  return JSON.stringify({
    schema_version: 1,
    job_id: jobId,
    role_id: "extractor",
    observations: [],
    proposals: [],
    abstentions: [
      {
        reason_code: text.includes("CALL_TOOL")
          ? "unsafe_instruction"
          : "no_durable_value",
        detail: `extractor project=${projectId} images=${imageCount} forwarded=${text.includes('"is_forwarded":true')}`,
        evidence_ids: ["fragment-1"],
      },
    ],
  });
}
function finish() {
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: output(pendingText) },
  });
  send({
    jsonrpc: "2.0",
    id: pendingPrompt,
    result: {
      stopReason: pendingText.includes("NON_END_TURN")
        ? "cancelled"
        : "end_turn",
    },
  });
  pendingPrompt = undefined;
}

readline.createInterface({ input: process.stdin }).on("line", (raw) => {
  const message = JSON.parse(raw);
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize")
    reply({
      protocolVersion: 1,
      agentInfo: { name: "role-fixture", version: "1" },
      agentCapabilities: {
        promptCapabilities: { image: !args.has("--no-image") },
        sessionCapabilities: { close: {} },
      },
    });
  else if (message.method === "session/new") {
    reply({ sessionId, configOptions: options() });
    if (!args.has("--no-discovery"))
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: (
          message.params?._meta?.trae?.options?.skills || []
        ).map((name) => ({ name, description: `Loaded ${name}` })),
      });
  } else if (message.method === "session/set_config_option") {
    if (message.params.configId === "model") model = message.params.value;
    else effort = message.params.value;
    reply({ configOptions: options() });
  } else if (message.method === "session/prompt") {
    pendingPrompt = message.id;
    pendingText = message.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (pendingText.includes("TIMEOUT")) return;
    if (pendingText.includes("CALL_TOOL")) {
      send({
        jsonrpc: "2.0",
        id: "role-permission-1",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "dangerous-call", title: "Run shell" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    finish();
  } else if (message.method === "session/close") reply({});
  else if (message.method === "session/cancel")
    send({
      jsonrpc: "2.0",
      id: pendingPrompt,
      result: { stopReason: "cancelled" },
    });
  else if (message.id === "role-permission-1") {
    if (message.result.outcome.outcome !== "cancelled") process.exit(8);
    finish();
  }
});
