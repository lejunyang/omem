import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  larkOnboardingStartSchema,
  larkExistingImportSchema,
  larkPairingConfirmSchema,
  larkPairingEventSchema,
} from "../../../../../packages/contracts/src/index.js";
import type { z } from "zod";
import { EncryptedSecretStore } from "./secret-store.js";
import {
  type LarkCapabilityProbe,
  type LarkRegistrationAdapter,
  type LarkRegistrationCredentials,
  OfficialLarkRegistrationAdapter,
} from "./registration.js";
import type { ExistingLarkAppProvider } from "./existing-apps.js";

type Row = Record<string, unknown>;
type StartInput = z.infer<typeof larkOnboardingStartSchema>;

const iso = (date: Date) => date.toISOString();

export class LarkOnboardingService {
  private readonly active = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();

  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets: EncryptedSecretStore,
    private readonly registration: LarkRegistrationAdapter,
    private readonly capabilities: LarkCapabilityProbe,
    private readonly clock: () => Date = () => new Date(),
    private readonly existingApps?: ExistingLarkAppProvider,
  ) {}

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private transition(
    onboardingId: string,
    status: string,
    detail: Record<string, unknown> = {},
    fields: Record<string, string | number | null> = {},
  ) {
    const assignments = ["status=?", "updated_at=?"];
    const values: (string | number | null)[] = [status, iso(this.clock())];
    for (const [key, value] of Object.entries(fields)) {
      assignments.push(`${key}=?`);
      values.push(value);
    }
    values.push(onboardingId);
    const changed = this.db
      .prepare(
        `UPDATE lark_onboardings SET ${assignments.join(",")} WHERE id=?`,
      )
      .run(...values);
    if (Number(changed.changes) !== 1) throw Error("LARK_ONBOARDING_NOT_FOUND");
    this.db
      .prepare(
        "INSERT INTO lark_onboarding_events(id,onboarding_id,status,detail,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        onboardingId,
        status,
        JSON.stringify(detail),
        iso(this.clock()),
      );
  }

  async start(value: unknown) {
    const input = larkOnboardingStartSchema.parse(value);
    const id = randomUUID();
    const at = iso(this.clock());
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO lark_onboardings(
             id,workspace_id,mode,requested_app_id,requested_config,
             registration_generation,status,created_at,updated_at
           ) VALUES(?,'personal',?,?,?,?, 'draft',?,?)`,
        )
        .run(
          id,
          input.mode,
          input.appId ?? null,
          JSON.stringify(input.config),
          1,
          at,
          at,
        );
      this.db
        .prepare(
          "INSERT INTO lark_onboarding_events(id,onboarding_id,status,detail,created_at) VALUES(?,?,?,?,?)",
        )
        .run(randomUUID(), id, "draft", "{}", at);
    });
    const controller = new AbortController();
    let qrReady!: () => void;
    const qr = new Promise<void>((resolve) => (qrReady = resolve));
    const completion = this.runRegistration(id, input, controller, qrReady);
    this.active.set(id, { controller, completion });
    void completion.finally(() => this.active.delete(id)).catch(() => {});
    await Promise.race([qr, completion]);
    return this.status(id);
  }

  listReusableApps() {
    return this.existingApps?.list() ?? [];
  }

  async importExisting(value: unknown) {
    const input = larkExistingImportSchema.parse(value);
    const id = randomUUID();
    const at = iso(this.clock());
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO lark_onboardings(
             id,workspace_id,mode,requested_app_id,requested_config,
             registration_generation,status,created_at,updated_at
           ) VALUES(?,'personal','existing',?,?,1,'draft',?,?)`,
        )
        .run(id, input.appId, JSON.stringify(input.config), at, at);
      this.db
        .prepare(
          "INSERT INTO lark_onboarding_events(id,onboarding_id,status,detail,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          id,
          "draft",
          JSON.stringify({ credentialSource: input.source }),
          at,
        );
    });
    let credentials: LarkRegistrationCredentials;
    if (input.source === "botmux") {
      if (!this.existingApps) throw Error("BOTMUX_APP_PROVIDER_NOT_CONFIGURED");
      credentials = this.existingApps.credentials(input.appId);
    } else {
      credentials = {
        clientId: input.appId,
        clientSecret: input.clientSecret!,
      };
    }
    await this.acceptCredentials(
      id,
      { mode: "existing", appId: input.appId, config: input.config },
      credentials,
    );
    return this.status(id);
  }

  private async runRegistration(
    onboardingId: string,
    input: StartInput,
    controller: AbortController,
    qrReady: () => void,
  ) {
    try {
      const credentials = await this.registration.register({
        createOnly: input.mode === "new",
        appId: input.mode === "existing" ? input.appId : undefined,
        config: input.config,
        signal: controller.signal,
        onQrCode: ({ url, expiresInSeconds }) => {
          if (!/^https:\/\//.test(url)) throw Error("LARK_QR_URL_INVALID");
          const row = this.db
            .prepare("SELECT status FROM lark_onboardings WHERE id=?")
            .get(onboardingId) as Row | undefined;
          if (!row || row.status === "cancelled") return;
          this.transition(
            onboardingId,
            "awaiting_scan",
            { expiresInSeconds },
            {
              qr_url: url,
              qr_expires_at: iso(
                new Date(this.clock().getTime() + expiresInSeconds * 1000),
              ),
            },
          );
          qrReady();
        },
        onStatus: (status) => {
          const row = this.db
            .prepare("SELECT status FROM lark_onboardings WHERE id=?")
            .get(onboardingId) as Row | undefined;
          if (!row || row.status === "cancelled") return;
          this.db
            .prepare(
              "INSERT INTO lark_onboarding_events(id,onboarding_id,status,detail,created_at) VALUES(?,?,?,?,?)",
            )
            .run(
              randomUUID(),
              onboardingId,
              String(row.status),
              JSON.stringify(status),
              iso(this.clock()),
            );
        },
      });
      await this.acceptCredentials(onboardingId, input, credentials);
    } catch (error) {
      const row = this.db
        .prepare("SELECT status FROM lark_onboardings WHERE id=?")
        .get(onboardingId) as Row | undefined;
      if (!row || row.status === "cancelled") return;
      const message =
        error instanceof Error ? error.message : "registration failed";
      const code = String((error as { code?: unknown })?.code ?? "failed");
      const status = /access_denied|denied/i.test(code + message)
        ? "denied"
        : /expired_token|expired/i.test(code + message)
          ? "expired"
          : /abort/i.test(code + message)
            ? "cancelled"
            : "failed";
      this.transition(
        onboardingId,
        status,
        { errorCode: code },
        {
          error_code: code,
          error_message: message.replace(/[\r\n]+/g, " ").slice(0, 1000),
        },
      );
    }
  }

  private async acceptCredentials(
    onboardingId: string,
    input: StartInput,
    credentials: LarkRegistrationCredentials,
  ) {
    if (!/^cli_[a-zA-Z0-9]+$/.test(credentials.clientId))
      throw Error("LARK_APP_ID_INVALID");
    if (!credentials.clientSecret) throw Error("LARK_SECRET_MISSING");
    if (input.mode === "existing" && credentials.clientId !== input.appId)
      throw Error("LARK_EXISTING_APP_MISMATCH");
    const row = this.db
      .prepare("SELECT status FROM lark_onboardings WHERE id=?")
      .get(onboardingId) as Row | undefined;
    if (!row) return;
    if (row.status === "cancelled") {
      this.db
        .prepare(
          `UPDATE lark_onboardings SET external_app_id=?,
             error_code='late_credentials_needs_review',
             error_message='Registration returned credentials after cancellation; verify the external app manually',
             updated_at=? WHERE id=? AND status='cancelled'`,
        )
        .run(credentials.clientId, iso(this.clock()), onboardingId);
      this.db
        .prepare(
          "INSERT INTO lark_onboarding_events(id,onboarding_id,status,detail,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          onboardingId,
          "cancelled",
          JSON.stringify({
            lateCredentials: true,
            appId: credentials.clientId,
          }),
          iso(this.clock()),
        );
      return;
    }
    if (row.status !== "awaiting_scan" && row.status !== "draft") return;
    this.transition(
      onboardingId,
      "credentials_received",
      { appId: credentials.clientId },
      {
        external_app_id: credentials.clientId,
        user_info: JSON.stringify(credentials.userInfo ?? {}),
      },
    );
    const secretRef = this.secrets.put({
      appId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    let connectionId = "";
    let version = 0;
    try {
      this.transaction(() => {
        const current = this.db
          .prepare("SELECT status FROM lark_onboardings WHERE id=?")
          .get(onboardingId) as Row;
        if (current.status !== "credentials_received")
          throw Error("LARK_ONBOARDING_STALE");
        let connection = this.db
          .prepare(
            "SELECT * FROM lark_connections WHERE workspace_id='personal' AND app_id=?",
          )
          .get(credentials.clientId) as Row | undefined;
        if (!connection) {
          connectionId = randomUUID();
          this.db
            .prepare(
              `INSERT INTO lark_connections(
                 id,workspace_id,app_id,tenant_brand,tenant_key,state,
                 active_version,owner_open_id,created_at,updated_at
               ) VALUES(?,'personal',?,?,NULL,'checking',NULL,NULL,?,?)`,
            )
            .run(
              connectionId,
              credentials.clientId,
              credentials.userInfo?.tenantBrand ?? null,
              iso(this.clock()),
              iso(this.clock()),
            );
          connection = { id: connectionId, active_version: null };
        } else connectionId = String(connection.id);
        version = Number(
          (
            this.db
              .prepare(
                "SELECT COALESCE(MAX(version),0)+1 AS version FROM lark_connection_versions WHERE connection_id=?",
              )
              .get(connectionId) as { version: number }
          ).version,
        );
        this.db
          .prepare(
            `INSERT INTO lark_connection_versions(
               id,connection_id,version,secret_ref,requested_config,
               capability_profile,missing_capabilities,state,created_at,updated_at
             ) VALUES(?,?,?,?,?,'{}','[]','checking',?,?)`,
          )
          .run(
            randomUUID(),
            connectionId,
            version,
            secretRef,
            JSON.stringify(input.config),
            iso(this.clock()),
            iso(this.clock()),
          );
        this.transition(
          onboardingId,
          "checking",
          { appId: credentials.clientId, version },
          { connection_version: version },
        );
      });
    } catch (error) {
      this.secrets.remove(secretRef);
      throw error;
    }
    let checked;
    try {
      checked = await this.capabilities.probe(
        { appId: credentials.clientId, clientSecret: credentials.clientSecret },
        input.config,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "capability probe failed";
      this.transaction(() => {
        this.db
          .prepare(
            "UPDATE lark_connection_versions SET state='failed',updated_at=? WHERE connection_id=? AND version=?",
          )
          .run(iso(this.clock()), connectionId, version);
        const connection = this.db
          .prepare("SELECT active_version FROM lark_connections WHERE id=?")
          .get(connectionId) as Row;
        this.db
          .prepare(
            "UPDATE lark_connections SET state=?,updated_at=? WHERE id=?",
          )
          .run(
            connection.active_version ? "active" : "failed",
            iso(this.clock()),
            connectionId,
          );
        this.transition(
          onboardingId,
          "failed",
          { errorCode: "capability_probe_failed" },
          {
            error_code: "capability_probe_failed",
            error_message: message.replace(/[\r\n]+/g, " ").slice(0, 1000),
          },
        );
      });
      return;
    }
    this.transaction(() => {
      const onboarding = this.db
        .prepare("SELECT status FROM lark_onboardings WHERE id=?")
        .get(onboardingId) as Row;
      if (onboarding.status === "cancelled") {
        this.db
          .prepare(
            "UPDATE lark_connection_versions SET state='failed',updated_at=? WHERE connection_id=? AND version=?",
          )
          .run(iso(this.clock()), connectionId, version);
        this.secrets.remove(secretRef);
        return;
      }
      const missing = [...new Set(checked.missing)].sort();
      const next = missing.length ? "failed" : "awaiting_pair";
      this.db
        .prepare(
          `UPDATE lark_connection_versions SET capability_profile=?,
             missing_capabilities=?,state=?,updated_at=?
           WHERE connection_id=? AND version=?`,
        )
        .run(
          JSON.stringify(checked.actual),
          JSON.stringify(missing),
          next,
          iso(this.clock()),
          connectionId,
          version,
        );
      this.db
        .prepare(
          `UPDATE lark_connections SET tenant_brand=?,state=CASE
             WHEN active_version IS NOT NULL THEN 'active' ELSE ? END,updated_at=?
           WHERE id=?`,
        )
        .run(
          credentials.userInfo?.tenantBrand ?? null,
          next,
          iso(this.clock()),
          connectionId,
        );
      this.transition(
        onboardingId,
        next,
        { missing, repairHint: checked.repairHint ?? null },
        missing.length
          ? {
              error_code: "missing_capabilities",
              error_message:
                checked.repairHint ?? `Missing: ${missing.join(", ")}`,
            }
          : {},
      );
    });
  }

  async wait(onboardingId: string) {
    await this.active.get(onboardingId)?.completion;
    return this.status(onboardingId);
  }

  cancel(onboardingId: string) {
    const active = this.active.get(onboardingId);
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT status FROM lark_onboardings WHERE id=?")
        .get(onboardingId) as Row | undefined;
      if (!row) throw Error("LARK_ONBOARDING_NOT_FOUND");
      if (
        ["active", "cancelled", "denied", "expired", "failed"].includes(
          String(row.status),
        )
      )
        return;
      this.transition(
        onboardingId,
        "cancelled",
        {},
        {
          cancelled_at: iso(this.clock()),
        },
      );
    });
    active?.controller.abort();
    return this.status(onboardingId);
  }

  status(onboardingId: string) {
    const row = this.db
      .prepare(
        `SELECT o.*,c.id AS connection_id,c.state AS connection_state,
           c.active_version,c.owner_open_id,v.capability_profile,
           v.missing_capabilities,v.state AS candidate_state
         FROM lark_onboardings o
         LEFT JOIN lark_connections c ON c.app_id=o.external_app_id
           AND c.workspace_id=o.workspace_id
         LEFT JOIN lark_connection_versions v ON v.connection_id=c.id
           AND v.version=o.connection_version
         WHERE o.id=?`,
      )
      .get(onboardingId) as Row | undefined;
    if (!row) throw Error("LARK_ONBOARDING_NOT_FOUND");
    return {
      id: String(row.id),
      mode: String(row.mode),
      requestedAppId: row.requested_app_id
        ? String(row.requested_app_id)
        : null,
      status: String(row.status),
      qrUrl: row.qr_url ? String(row.qr_url) : null,
      qrExpiresAt: row.qr_expires_at ? String(row.qr_expires_at) : null,
      appId: row.external_app_id ? String(row.external_app_id) : null,
      userInfo: row.user_info ? JSON.parse(String(row.user_info)) : null,
      connectionId: row.connection_id ? String(row.connection_id) : null,
      connectionVersion: row.connection_version
        ? Number(row.connection_version)
        : null,
      activeVersion: row.active_version ? Number(row.active_version) : null,
      ownerOpenId: row.owner_open_id ? String(row.owner_open_id) : null,
      capabilityProfile: row.capability_profile
        ? JSON.parse(String(row.capability_profile))
        : null,
      missingCapabilities: row.missing_capabilities
        ? JSON.parse(String(row.missing_capabilities))
        : [],
      errorCode: row.error_code ? String(row.error_code) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  issuePairingCode(onboardingId: string, ttlMs = 300_000) {
    const onboarding = this.status(onboardingId);
    if (onboarding.status !== "awaiting_pair" || !onboarding.connectionId)
      throw Error("LARK_ONBOARDING_NOT_READY_FOR_PAIRING");
    const code = randomBytes(24).toString("base64url");
    const id = randomUUID();
    const at = iso(this.clock());
    const expiresAt = iso(new Date(this.clock().getTime() + ttlMs));
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE lark_pairing_codes SET consumed_at=?
           WHERE connection_id=? AND consumed_at IS NULL`,
        )
        .run(at, onboarding.connectionId);
      this.db
        .prepare(
          `INSERT INTO lark_pairing_codes(
             id,connection_id,connection_version,code_hash,expires_at,
             consumed_at,candidate_open_id,candidate_chat_id,
             candidate_chat_type,attempts,max_attempts,created_at
           ) VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL,0,5,?)`,
        )
        .run(
          id,
          onboarding.connectionId,
          onboarding.connectionVersion,
          this.secrets.hashPairingCode(code),
          expiresAt,
          at,
        );
    });
    return { id, code, expiresAt };
  }

  receivePairing(value: unknown) {
    const input = larkPairingEventSchema.parse(value);
    const codeHash = this.secrets.hashPairingCode(input.code);
    return this.transaction(() => {
      const pairing = this.db
        .prepare(
          `SELECT p.*,c.app_id FROM lark_pairing_codes p
           JOIN lark_connections c ON c.id=p.connection_id
           WHERE p.code_hash=? ORDER BY p.created_at DESC LIMIT 1`,
        )
        .get(codeHash) as Row | undefined;
      if (!pairing) {
        const latest = this.db
          .prepare(
            `SELECT p.id,p.attempts,p.max_attempts FROM lark_pairing_codes p
             JOIN lark_connections c ON c.id=p.connection_id
             WHERE c.app_id=? AND p.consumed_at IS NULL
             ORDER BY p.created_at DESC LIMIT 1`,
          )
          .get(input.appId) as Row | undefined;
        if (latest)
          this.db
            .prepare(
              `UPDATE lark_pairing_codes SET attempts=attempts+1,
                 consumed_at=CASE WHEN attempts+1>=max_attempts THEN ? ELSE consumed_at END
               WHERE id=?`,
            )
            .run(iso(this.clock()), String(latest.id));
        throw Error("LARK_PAIRING_CODE_INVALID");
      }
      if (pairing.app_id !== input.appId)
        throw Error("LARK_PAIRING_APP_MISMATCH");
      if (pairing.consumed_at) throw Error("LARK_PAIRING_ALREADY_CONSUMED");
      if (String(pairing.expires_at) <= iso(this.clock()))
        throw Error("LARK_PAIRING_EXPIRED");
      if (
        pairing.candidate_open_id &&
        (pairing.candidate_open_id !== input.senderOpenId ||
          pairing.candidate_chat_id !== input.chatId)
      )
        throw Error("LARK_PAIRING_ACTOR_MISMATCH");
      this.db
        .prepare(
          `UPDATE lark_pairing_codes SET candidate_open_id=?,candidate_chat_id=?,
             candidate_chat_type=? WHERE id=?`,
        )
        .run(
          input.senderOpenId,
          input.chatId,
          input.chatType,
          String(pairing.id),
        );
      return {
        pairingId: String(pairing.id),
        senderOpenId: input.senderOpenId,
        chatId: input.chatId,
        chatType: input.chatType,
      };
    });
  }

  confirmPairing(value: unknown) {
    const input = larkPairingConfirmSchema.parse(value);
    return this.transaction(() => {
      const pairing = this.db
        .prepare(
          `SELECT p.*,c.workspace_id,c.app_id,c.active_version
           FROM lark_pairing_codes p JOIN lark_connections c
             ON c.id=p.connection_id WHERE p.id=?`,
        )
        .get(input.pairingId) as Row | undefined;
      if (!pairing) throw Error("LARK_PAIRING_NOT_FOUND");
      if (pairing.consumed_at) throw Error("LARK_PAIRING_ALREADY_CONSUMED");
      if (String(pairing.expires_at) <= iso(this.clock()))
        throw Error("LARK_PAIRING_EXPIRED");
      if (!pairing.candidate_open_id || !pairing.candidate_chat_id)
        throw Error("LARK_PAIRING_NOT_VERIFIED");
      if (pairing.candidate_open_id !== input.expectedOpenId)
        throw Error("LARK_PAIRING_ACTOR_MISMATCH");
      const previous = this.db
        .prepare(
          `SELECT * FROM lark_bindings
           WHERE connection_id=? AND state='active'
           ORDER BY binding_version DESC LIMIT 1`,
        )
        .get(String(pairing.connection_id)) as Row | undefined;
      const bindingVersion = Number(previous?.binding_version ?? 0) + 1;
      if (previous) {
        this.db
          .prepare("UPDATE lark_bindings SET state='superseded' WHERE id=?")
          .run(String(previous.id));
        this.db
          .prepare(
            "UPDATE lark_card_actions SET state='cancelled' WHERE binding_id=? AND state='pending'",
          )
          .run(String(previous.id));
        this.db
          .prepare(
            `UPDATE delivery_intents SET state='cancelled',updated_at=?,
               last_error='binding superseded'
             WHERE binding_id=? AND state IN ('pending','retry_wait')`,
          )
          .run(iso(this.clock()), String(previous.id));
      }
      this.db
        .prepare(
          "UPDATE lark_targets SET state='disabled',updated_at=? WHERE connection_id=? AND state='active'",
        )
        .run(iso(this.clock()), String(pairing.connection_id));
      this.db
        .prepare(
          "UPDATE lark_connection_versions SET state='superseded',updated_at=? WHERE connection_id=? AND state='active'",
        )
        .run(iso(this.clock()), String(pairing.connection_id));
      this.db
        .prepare(
          "UPDATE lark_connection_versions SET state='active',updated_at=? WHERE connection_id=? AND version=? AND state='awaiting_pair'",
        )
        .run(
          iso(this.clock()),
          String(pairing.connection_id),
          Number(pairing.connection_version),
        );
      const bindingId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO lark_bindings(
             id,workspace_id,connection_id,connection_version,binding_version,
             owner_open_id,target_chat_id,target_type,state,
             supersedes_binding_id,created_at
           ) VALUES(?,?,?,?,?,?,?,?,'active',?,?)`,
        )
        .run(
          bindingId,
          String(pairing.workspace_id),
          String(pairing.connection_id),
          Number(pairing.connection_version),
          bindingVersion,
          String(pairing.candidate_open_id),
          String(pairing.candidate_chat_id),
          String(pairing.candidate_chat_type),
          previous?.id ? String(previous.id) : null,
          iso(this.clock()),
        );
      for (const purpose of ["owner_notification", "decision"] as const)
        this.db
          .prepare(
            `INSERT INTO lark_targets(
               id,workspace_id,connection_id,binding_version,chat_id,
               target_type,purpose,capture_enabled,state,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,0,'active',?,?)`,
          )
          .run(
            randomUUID(),
            String(pairing.workspace_id),
            String(pairing.connection_id),
            bindingVersion,
            String(pairing.candidate_chat_id),
            String(pairing.candidate_chat_type),
            purpose,
            iso(this.clock()),
            iso(this.clock()),
          );
      if (pairing.candidate_chat_type === "group")
        this.db
          .prepare(
            `INSERT INTO lark_targets(
               id,workspace_id,connection_id,binding_version,chat_id,
               target_type,purpose,capture_enabled,state,created_at,updated_at
             ) VALUES(?,?,?,?,?,'group','group_monitoring',0,'pending_approval',?,?)`,
          )
          .run(
            randomUUID(),
            String(pairing.workspace_id),
            String(pairing.connection_id),
            bindingVersion,
            String(pairing.candidate_chat_id),
            iso(this.clock()),
            iso(this.clock()),
          );
      this.db
        .prepare(
          `UPDATE lark_connections SET state='active',active_version=?,
             owner_open_id=?,updated_at=? WHERE id=?`,
        )
        .run(
          Number(pairing.connection_version),
          String(pairing.candidate_open_id),
          iso(this.clock()),
          String(pairing.connection_id),
        );
      this.db
        .prepare("UPDATE lark_pairing_codes SET consumed_at=? WHERE id=?")
        .run(iso(this.clock()), String(pairing.id));
      this.db
        .prepare(
          `UPDATE lark_onboardings SET status='active',updated_at=?
           WHERE external_app_id=? AND connection_version=? AND status='awaiting_pair'`,
        )
        .run(
          iso(this.clock()),
          String(pairing.app_id),
          Number(pairing.connection_version),
        );
      return {
        bindingId,
        appId: String(pairing.app_id),
        bindingVersion,
        ownerOpenId: String(pairing.candidate_open_id),
        targetChatId: String(pairing.candidate_chat_id),
        targetType: String(pairing.candidate_chat_type),
      };
    });
  }

  connections() {
    return this.db
      .prepare(
        `SELECT id,workspace_id AS workspaceId,app_id AS appId,tenant_brand AS tenantBrand,
           state,active_version AS activeVersion,owner_open_id AS ownerOpenId,
           created_at AS createdAt,updated_at AS updatedAt
         FROM lark_connections ORDER BY created_at`,
      )
      .all();
  }
}

export function createOfficialLarkOnboarding(input: {
  db: DatabaseSync;
  dataDir: string;
  capabilityProbe: LarkCapabilityProbe;
  clock?: () => Date;
  existingApps?: ExistingLarkAppProvider;
}) {
  return new LarkOnboardingService(
    input.db,
    EncryptedSecretStore.fromEnvironment(input.dataDir),
    new OfficialLarkRegistrationAdapter(),
    input.capabilityProbe,
    input.clock,
    input.existingApps,
  );
}
