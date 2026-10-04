// Deterministic ACP protocol fixture for role-runtime tests. It is never a production model.
import readline from "node:readline";

const args = new Set(process.argv.slice(2));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sessionId = `role-session-${process.pid}`;
let model = "alpha";
let effort = "low";
let pendingPrompt;
let pendingText = "";
let mcpServers = [];
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
  const imageCount = JSON.parse(text.match(/\[TRUSTED CONTEXT\]\s*(\{[^\n]+\})/)[1]).material_index.filter(m => m.image).length;
  if (text.includes("OUTPUT_FLOOD")) return "x".repeat(120_000);
  if (text.includes("MALFORMED_OUTPUT")) return "not-json";
  if (roleId.endsWith("-analyst") || roleId === "knowledge-writer" || roleId === "knowledge-refresher") {
    const keys = JSON.parse(text.match(/"targetKeys":(\[[^\]]+\])/)?.[1] || '["manual:a"]');
    return JSON.stringify({ schema_version: 1, documents: keys.map(key => ({ key, title: "Fixture knowledge", summary: "Fixture summary", category: "implementation", sections: [{key:"behavior",title:"Behavior",body:"Fixed source is cited here.[[c1]]"}], citations:[{key:"c1",label:"Fixed source",reason:"Supports the behavior",relation:"supports",target:{kind:"material",key,startLine:1,endLine:1},quote:""}],questions:[] })) });
  }
  if (text.includes("REFRESH_FACT")) {
    const ctx = JSON.parse(text.match(/\[TRUSTED CONTEXT\]\s*(\{[^\n]+\})/)[1]);
    if (roleId === "verifier") return JSON.stringify({ schema_version: 1, job_id: jobId, role_id: roleId,
      assessments: ctx.candidates.map(c => ({ proposal_id: c.proposal_id, proposal_digest: c.proposal_digest,
        quote_asset_verdict: "valid", semantic_verdict: "supported", reason_code: "fixture_support",
        ...(c.operation === "create" ? {} : { update_relation: "amends" }),
        reason: "Current fixed source supports updated limit.", missing_context: [] })) });
    const m = JSON.parse(text.match(/\[UNTRUSTED MATERIAL JSON\]\s*(\{[^\n]+\})/)[1]);
    const target = ctx.task.refreshTargets[0] ?? ctx.related_memories.find(m => m.kind === "claim" && m.scope?.project_id === ctx.trusted_context.project_id);
    return JSON.stringify({ schema_version: 1, job_id: jobId, role_id: "extractor", observations: [], abstentions: [],
      proposals: [{ schema_version: 1, proposal_id: "refresh-fixture", kind: "claim", operation: target ? "update" : "create",
        ...(target ? { target_id: target.memory_id } : {}),
        scope: target?.scope ?? { workspace_id: "personal", project_id: ctx.trusted_context.project_id, subject_id: "owner" },
        body: { statement: m.text, attribution: "source states", valid_from: null, valid_to: null },
        evidence: [{ fragment_revision_id: m.fragment_revision_id, source_revision_id: m.source_revision_id,
          exact_quote: m.text, selector: { start: 0, end: Array.from(m.text).length, unit: "unicode_codepoint" } }],
        uncertainties: [], reason: "Recheck against new source", expected_versions: target ? { [target.memory_id]: target.version } : {},
        origin: { job_id: jobId, role_bundle: "extractor@1", producer_kind: "derived" } }] });
  }
  if (roleId === "verifier") {
    // Batch acceptance: the verifier context carries a `candidates` array with one
    // entry per proposal (each with proposal_id + proposal_digest). Return one
    // supported assessment per candidate so the whole ChangeSet reaches evaluateBatch.
    if (text.includes("BATCH_CREATE")) {
      const ids = [...text.matchAll(/"proposal_id":"([^"]+)"/g)].map((m) => m[1]);
      const digests = [
        ...text.matchAll(/"proposal_digest":"([a-f0-9]{64})"/g),
      ].map((m) => m[1]);
      return JSON.stringify({
        schema_version: 1,
        job_id: jobId,
        role_id: "verifier",
        assessments: ids.map((id, i) => ({
          proposal_id: id,
          proposal_digest: digests[i] ?? "0".repeat(64),
          quote_asset_verdict: "valid",
          semantic_verdict: "supported",
          reason_code: "fixture_batch_support",
          reason: "Batch fixture supports each proposal in the ChangeSet.",
          missing_context: [],
        })),
      });
    }
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
  if (text.includes("BATCH_CREATE_DISTINCT") || text.includes("BATCH_CREATE_SAME")) {
    const distinct = text.includes("BATCH_CREATE_DISTINCT");
    const quote = distinct ? "BATCH_CREATE_DISTINCT" : "BATCH_CREATE_SAME";
    const fragmentRef = field(text, "fragment_revision_id", "missing-fragment");
    const sourceRef = field(text, "source_revision_id", "missing-revision");
    const proposals = Array.from({ length: 12 }, (_, i) => ({
      schema_version: 1,
      proposal_id: `batch-proposal-${i}`,
      kind: "claim",
      operation: "create",
      scope: {
        workspace_id: "personal",
        project_id: projectId === "none" ? null : projectId,
        subject_id: "owner",
      },
      body: {
        statement: distinct ? `批量事实 ${i}` : "批量同一事实",
        attribution: "source states",
        valid_from: null,
        valid_to: null,
      },
      evidence: [
        {
          fragment_revision_id: fragmentRef,
          source_revision_id: sourceRef,
          exact_quote: quote,
          selector: { start: 0, end: quote.length, unit: "unicode_codepoint" },
        },
      ],
      uncertainties: [],
      reason: `batch claim ${i}`,
      expected_versions: {},
      origin: {
        job_id: jobId,
        role_bundle: "extractor@1",
        producer_kind: "derived",
      },
    }));
    return JSON.stringify({
      schema_version: 1,
      job_id: jobId,
      role_id: "extractor",
      observations: [],
      proposals,
      abstentions: [],
    });
  }
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
        detail: `extractor project=${projectId} images=${imageCount} forwarded=${text.includes('"is_forwarded":true')} projectTrusted=${text.includes('"project_trusted":true')} actors=${[...pendingText.matchAll(/"actor_external_id":"([^"]+)"/g)].map((m) => m[1]).join("|")} assetRefs=${[...pendingText.matchAll(/"asset_ref":"([a-f0-9]{64})"/g)].length}`,
        evidence_ids: ["fragment-1"],
      },
    ],
  });
}
async function finish() {
  let value = output(pendingText);
  const server = mcpServers.find(s => s.name === "omem" && s.type === "http");
  if (server) {
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ]);
    const client = new Client({ name: "learning-protocol-fixture", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const batch = JSON.parse(value);
      if (args.has("--repair-foreign-task") && batch.role_id === "extractor") {
        batch.proposals[0].body.owner_id = "colleague";
        const rejected = await client.callTool({ name: "submit_result", arguments: { result: batch } });
        if (!rejected.isError || !JSON.stringify(rejected.content).includes("ROLE_OUTPUT_TASK_OWNER"))
          throw Error("Expected actionable task-owner feedback before a corrected submission");
        batch.proposals[0].kind = "claim";
        batch.proposals[0].body = { statement: "同事负责这次集成", attribution: "原文记录", valid_from: null, valid_to: null };
        batch.proposals[0].uncertainties = ["没有说明采用哪种集成方案"];
        value = JSON.stringify(batch);
      }
      if (args.has("--repair-foreign-task") && batch.role_id === "verifier") {
        batch.assessments[0].uncertainty_review = {
          verdict: "non_blocking", reason: "具体方案不影响明确陈述的负责人事实。",
        };
        value = JSON.stringify(batch);
      }
      const result = await client.callTool({ name: "submit_result", arguments: { result: JSON.parse(value) } });
      if (result.isError) throw Error(JSON.stringify(result.content));
    } catch (e) {
      send({ jsonrpc: "2.0", id: pendingPrompt, error: { code: -32000, message: String(e) } });
      return;
    } finally { await client.close(); }
  }
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: value },
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
    mcpServers = message.params?.mcpServers ?? [];
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
