import { probeReceipt } from "../src/agents/cloud-probe.ts";
import type { App } from "../src/core/app.ts";

export function fakeCloudReceipt(app: App, nonce: string, mode: "url" | "header") {
  const auth = mode === "header" ? "Bearer probe-" + nonce : undefined;
  const { next } = probeReceipt(app, nonce, "GET", auth);
  return probeReceipt(app, next!.split("/").pop()!, mode === "header" ? "POST" : "GET", auth, { probe: nonce }).receipt!;
}
