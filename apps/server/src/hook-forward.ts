/** Opt-in hook transport. No model invocation and no stdout; failures never block the host. */
import { resolve, join } from "node:path";
import {
  defaultHookCaptureProfile,
  hookInput,
  type HookCaptureField,
} from "./connectors.js";
import { HookSpool, type CaptureAcknowledgement } from "./inputs/spool.js";
const chunks: Buffer[] = [];
let bytes = 0;
try {
  for await (const c of process.stdin) {
    bytes += c.length;
    if (bytes > 300000) throw Error("Capture budget exceeded");
    chunks.push(c);
  }
  const allowedFields = new Set<HookCaptureField>(
    defaultHookCaptureProfile.fields,
  );
  const requestedFields = process.env.OMEM_HOOK_FIELDS
    ? process.env.OMEM_HOOK_FIELDS.split(",").map((field) => field.trim())
    : [...defaultHookCaptureProfile.fields];
  if (
    requestedFields.some(
      (field) => !allowedFields.has(field as HookCaptureField),
    )
  )
    throw Error("Unknown OMEM_HOOK_FIELDS entry");
  const maxChars = Number(
    process.env.OMEM_HOOK_MAX_CHARS || defaultHookCaptureProfile.maxChars,
  );
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 200_000)
    throw Error("Invalid OMEM_HOOK_MAX_CHARS");
  const body = hookInput(JSON.parse(Buffer.concat(chunks).toString()), {
    id: (process.env.OMEM_HOOK_PROFILE_ID || "traex-env-v1").slice(0, 100),
    fields: requestedFields as HookCaptureField[],
    maxChars,
  });
  const spool = new HookSpool(
    resolve(
      process.env.OMEM_HOOK_SPOOL ||
        join(process.env.OMEM_DATA_DIR || ".omem", "hook-spool"),
    ),
  );
  spool.enqueue(body);
  const outcomes = await spool.flush(async (capture) => {
    const response = await fetch(
      (process.env.OMEM_URL || "http://127.0.0.1:4317") + "/api/captures",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.OMEM_TOKEN
            ? { Authorization: "Bearer " + process.env.OMEM_TOKEN }
            : {}),
        },
        body: JSON.stringify(capture),
        signal: AbortSignal.timeout(1500),
      },
    );
    if (!response.ok) throw Error(`HTTP_${response.status}`);
    return (await response.json()) as CaptureAcknowledgement;
  }, 3);
  if (outcomes.some((outcome) => !outcome.delivered))
    console.error("omem hook capture queued for retry; host continues");
} catch (error) {
  const reason = error instanceof Error ? error.message : "unavailable";
  console.error(
    `omem hook capture queued or rejected (${reason}); host continues`,
  );
}
