import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { larkInput } from "../apps/server/src/connectors.js";
import { LarkOnboardingService } from "../apps/server/src/integrations/lark/onboarding.js";
import {
  OfficialLarkCapabilityProbe,
  OfficialLarkRegistrationAdapter,
} from "../apps/server/src/integrations/lark/registration.js";
import { BotmuxExistingAppProvider } from "../apps/server/src/integrations/lark/existing-apps.js";
import { LarkRuntimeHost } from "../apps/server/src/integrations/lark/runtime.js";
import { EncryptedSecretStore } from "../apps/server/src/integrations/lark/secret-store.js";
import { MemoryService } from "../apps/server/src/memory/service.js";
import {
  importQualityDatasetEval,
  QUALITY_EVAL_ONLY,
} from "../apps/server/src/quality/import.js";
import { Store } from "../apps/server/src/store.js";

const sourceUri = process.argv[2] || process.env.OMEM_QUALITY_SOURCE;
if (!sourceUri) throw Error("Usage: quality-lark-annotate <Lark document URL>");
const dataDir = resolve(process.env.OMEM_DATA_DIR || ".omem");
const key = process.env.OMEM_SECRET_KEY
  ? process.env.OMEM_SECRET_KEY
  : process.env.OMEM_LARK_KEY_FILE
    ? readFileSync(resolve(process.env.OMEM_LARK_KEY_FILE), "utf8").trim()
    : null;
if (!key) throw Error("OMEM_SECRET_KEY or OMEM_LARK_KEY_FILE is required");
const appId = process.env.OMEM_LARK_APP_ID;
if (appId && !/^cli_[a-zA-Z0-9]+$/.test(appId))
  throw Error("OMEM_LARK_APP_ID is invalid");

const document = await larkInput(sourceUri);
const store = new Store(dataDir);
const secrets = new EncryptedSecretStore(resolve(dataDir, "secrets"), key);
const onboarding = new LarkOnboardingService(
  store.db,
  secrets,
  new OfficialLarkRegistrationAdapter(),
  new OfficialLarkCapabilityProbe(),
  () => new Date(),
  new BotmuxExistingAppProvider(),
);
const host = new LarkRuntimeHost({
  store,
  memory: new MemoryService(store, { ownerId: "owner" }),
  onboarding,
  secrets,
  pollMs: 500,
  workerId: "quality-annotation-live",
});

try {
  const imported = importQualityDatasetEval({
    optIn: QUALITY_EVAL_ONLY,
    repository: host.quality.repository,
    document,
    sourceUri,
    name: process.env.OMEM_QUALITY_DATASET || "merchant-center-dev-v1",
    split: "dev",
    targetCount: Number(process.env.OMEM_QUALITY_TARGET || 40),
  });
  const beforeEvents = Number(
    (
      store.db
        .prepare("SELECT count(*) AS count FROM quality_annotation_events")
        .get() as { count: number }
    ).count,
  );
  const session = host.quality.start(imported.id, appId, {
    resend: process.env.OMEM_QUALITY_RESEND === "1",
  });
  host.start();
  let ready = false;
  const timeoutMs = Number(process.env.OMEM_QUALITY_WAIT_MS || 3_600_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = store.db
      .prepare(
        `SELECT state,message_id AS messageId,current_sample_id AS currentSampleId
         FROM quality_annotation_sessions WHERE id=?`,
      )
      .get(session.id) as
      | {
          state: string;
          messageId: string | null;
          currentSampleId: string | null;
        }
      | undefined;
    if (!row) throw Error("QUALITY_ANNOTATION_SESSION_NOT_FOUND");
    if (!ready && row.messageId) {
      ready = true;
      console.log(
        JSON.stringify({
          state: "annotation_card_sent",
          datasetId: imported.id,
          sessionId: session.id,
          sampleCount: imported.sampleCount,
          messageId: row.messageId,
        }),
      );
    }
    const eventCount = Number(
      (
        store.db
          .prepare("SELECT count(*) AS count FROM quality_annotation_events")
          .get() as { count: number }
      ).count,
    );
    if (eventCount > beforeEvents) {
      console.log(
        JSON.stringify(
          {
            state: "annotation_received",
            datasetId: imported.id,
            sessionId: session.id,
            progress: host.quality.repository.progress(imported.id),
          },
          null,
          2,
        ),
      );
      process.exitCode = 0;
      break;
    }
    const delivery = store.db
      .prepare(
        `SELECT state,last_error AS lastError FROM delivery_intents
         WHERE annotation_session_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(session.id) as
      | { state: string; lastError: string | null }
      | undefined;
    if (delivery && ["failed", "unknown", "cancelled"].includes(delivery.state))
      throw Error(
        `QUALITY_CARD_DELIVERY_${delivery.state}: ${delivery.lastError}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw Error("QUALITY_CARD_NOT_DELIVERED");
  if (Date.now() >= deadline) throw Error("QUALITY_ANNOTATION_WAIT_TIMEOUT");
} finally {
  await host.stop();
  store.close();
}
