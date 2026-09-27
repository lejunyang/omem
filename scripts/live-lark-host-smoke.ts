import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LarkOnboardingService } from "../apps/server/src/integrations/lark/onboarding.js";
import { OMEM_LARK_DEFAULT_CONFIG } from "../apps/server/src/integrations/lark/defaults.js";
import {
  OfficialLarkCapabilityProbe,
  OfficialLarkRegistrationAdapter,
} from "../apps/server/src/integrations/lark/registration.js";
import { BotmuxExistingAppProvider } from "../apps/server/src/integrations/lark/existing-apps.js";
import { LarkRuntimeHost } from "../apps/server/src/integrations/lark/runtime.js";
import { EncryptedSecretStore } from "../apps/server/src/integrations/lark/secret-store.js";
import { MemoryService } from "../apps/server/src/memory/service.js";
import { Store } from "../apps/server/src/store.js";

const dataDir = resolve(process.env.OMEM_DATA_DIR || ".omem");
const key = process.env.OMEM_SECRET_KEY
  ? process.env.OMEM_SECRET_KEY
  : process.env.OMEM_LARK_KEY_FILE
    ? readFileSync(resolve(process.env.OMEM_LARK_KEY_FILE), "utf8").trim()
    : null;
if (!key)
  throw Error(
    "OMEM_SECRET_KEY or OMEM_LARK_KEY_FILE is required for live host validation",
  );
const store = new Store(dataDir);
const pending = Number(
  (
    store.db
      .prepare(
        `SELECT count(*) AS count FROM delivery_intents
         WHERE channel='lark' AND state IN ('pending','retry_wait','sending')`,
      )
      .get() as { count: number }
  ).count,
);
if (pending && process.env.OMEM_LIVE_ALLOW_DELIVERY !== "1") {
  store.close();
  throw Error(
    `Refusing live host smoke with ${pending} pending Lark deliveries; set OMEM_LIVE_ALLOW_DELIVERY=1 to send them`,
  );
}
const secrets = new EncryptedSecretStore(resolve(dataDir, "secrets"), key);
const activeConnection = store.db
  .prepare(
    `SELECT c.app_id,v.secret_ref FROM lark_connections c
     JOIN lark_connection_versions v ON v.connection_id=c.id
       AND v.version=c.active_version
     WHERE c.state='active' ORDER BY c.created_at LIMIT 1`,
  )
  .get() as { app_id: string; secret_ref: string } | undefined;
if (!activeConnection) {
  store.close();
  throw Error(
    "No active Lark connection is available for live host validation",
  );
}
const credentials = secrets.get(activeConnection.secret_ref);
if (credentials.appId !== activeConnection.app_id) {
  store.close();
  throw Error("LARK_SECRET_APP_MISMATCH");
}
const capabilityProbe = new OfficialLarkCapabilityProbe();
let capability: Awaited<ReturnType<OfficialLarkCapabilityProbe["probe"]>>;
try {
  capability = await capabilityProbe.probe(
    credentials,
    OMEM_LARK_DEFAULT_CONFIG,
  );
} catch (error) {
  store.close();
  throw error;
}
if (capability.missing.length) {
  store.close();
  throw Error(`LARK_CAPABILITY_MISSING:${capability.missing.length}`);
}
const onboarding = new LarkOnboardingService(
  store.db,
  secrets,
  new OfficialLarkRegistrationAdapter(),
  capabilityProbe,
  () => new Date(),
  new BotmuxExistingAppProvider(),
);
const host = new LarkRuntimeHost({
  store,
  memory: new MemoryService(store, { ownerId: "owner" }),
  onboarding,
  secrets,
  pollMs: 500,
  workerId: "live-lark-host-smoke",
});
const startedAt = new Date().toISOString();
try {
  host.start();
  let states: string[] = [];
  for (let index = 0; index < 180; index++) {
    states = (
      store.db
        .prepare(
          `SELECT state FROM lark_connection_events
           WHERE created_at>=? ORDER BY rowid`,
        )
        .all(startedAt) as { state: string }[]
    ).map((row) => row.state);
    if (states.includes("connected")) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!states.includes("connected"))
    throw Error(`LARK_RUNTIME_HOST_NOT_CONNECTED: ${states.join(",")}`);
  console.log(
    JSON.stringify(
      {
        connected: true,
        states,
        capability: {
          scopeCount: capability.actual.scopes.length,
          callbackCount: capability.actual.callbacks.length,
          eventVerification: capability.actual.eventVerification,
          botIdentityPresent: Boolean(capability.actual.botOpenId),
          missingCount: capability.missing.length,
        },
        pendingLarkDeliveriesBeforeStart: pending,
        runtime: host.status(),
      },
      null,
      2,
    ),
  );
} finally {
  await host.stop();
  store.close();
}
