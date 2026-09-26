/** Opt-in hook transport. No model invocation and no stdout; failures never block the host. */
import { hookInput } from "./connectors.js";
const chunks: Buffer[] = [];
let bytes = 0;
try {
  for await (const c of process.stdin) {
    bytes += c.length;
    if (bytes > 300000) throw Error("Capture budget exceeded");
    chunks.push(c);
  }
  const body = hookInput(JSON.parse(Buffer.concat(chunks).toString()));
  const r = await fetch(
    (process.env.OMEM_URL || "http://127.0.0.1:4317") + "/api/captures",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.OMEM_TOKEN
          ? { Authorization: "Bearer " + process.env.OMEM_TOKEN }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    },
  );
  if (!r.ok) console.error(`omem hook capture failed (${r.status})`);
} catch {
  console.error("omem hook capture unavailable; host continues");
}
