import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { larkRequestedConfigSchema } from "../../../packages/contracts/src/index.js";
import { LarkOnboardingService } from "../src/integrations/lark/onboarding.js";
import {
  OfficialLarkRegistrationAdapter,
  type LarkCapabilityProbe,
  type LarkCapabilityResult,
  type LarkRegistrationAdapter,
  type LarkRegistrationCredentials,
  type LarkRegistrationRequest,
} from "../src/integrations/lark/registration.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";
import { Store } from "../src/store.js";

const resources: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of resources.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeRegistration implements LarkRegistrationAdapter {
  requests: LarkRegistrationRequest[] = [];
  private resolve?: (credentials: LarkRegistrationCredentials) => void;
  private reject?: (error: Error) => void;

  register(request: LarkRegistrationRequest) {
    this.requests.push(request);
    request.onQrCode({
      url: "https://accounts.feishu.cn/qr/fixture",
      expiresInSeconds: 600,
    });
    return new Promise<LarkRegistrationCredentials>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  complete(credentials: LarkRegistrationCredentials) {
    this.resolve?.(credentials);
  }

  fail(code: string) {
    const error = new Error(code) as Error & { code: string };
    error.code = code;
    this.reject?.(error);
  }
}

class FakeProbe implements LarkCapabilityProbe {
  calls: { appId: string; clientSecret: string }[] = [];
  constructor(
    private readonly result: LarkCapabilityResult = {
      actual: {
        scopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "application:bot.basic_info:read",
          "im:message:update",
        ],
        events: ["im.message.receive_v1"],
        callbacks: ["card.action.trigger"],
        botOpenId: "ou_bot",
      },
      missing: [],
    },
  ) {}

  async probe(credentials: { appId: string; clientSecret: string }) {
    this.calls.push(credentials);
    return this.result;
  }
}

const requestedConfig = larkRequestedConfigSchema.parse({
  source: "omem",
  appPreset: {
    name: "{user}的 omem 助理",
    desc: "记录工作材料、事项与记忆变更，并按需提醒。",
  },
  addons: {
    preset: false,
    scopes: {
      tenant: [
        "im:message:send_as_bot",
        "im:message.p2p_msg:readonly",
        "application:bot.basic_info:read",
        "im:message:update",
      ],
    },
    events: { items: { tenant: ["im.message.receive_v1"] } },
    callbacks: { items: ["card.action.trigger"] },
  },
});

function setup(
  registration = new FakeRegistration(),
  probe: LarkCapabilityProbe = new FakeProbe(),
  clock: () => Date = () => new Date("2026-09-27T00:00:00.000Z"),
) {
  const directory = mkdtempSync(join(tmpdir(), "omem-lark-"));
  const store = new Store(directory);
  resources.push({ store, directory });
  const secrets = new EncryptedSecretStore(
    join(directory, "secrets"),
    randomBytes(32),
  );
  return {
    directory,
    store,
    secrets,
    registration,
    service: new LarkOnboardingService(
      store.db,
      secrets,
      registration,
      probe,
      clock,
    ),
  };
}

async function ready(
  setupResult: ReturnType<typeof setup>,
  credentials: LarkRegistrationCredentials = {
    clientId: "cli_test1",
    clientSecret: "fixture-client-secret",
    userInfo: { openId: "ou_scan_user", tenantBrand: "feishu" },
  },
  input: { mode: "new" | "existing"; appId?: string } = { mode: "new" },
) {
  const started = await setupResult.service.start({
    ...input,
    config: requestedConfig,
  });
  setupResult.registration.complete(credentials);
  return setupResult.service.wait(started.id);
}

describe("B2-05 Lark onboarding acceptance", () => {
  it("A-L01 maps createOnly/preset/addons to the official SDK and exposes QR metadata", async () => {
    let sdkOptions: Record<string, unknown> | undefined;
    const adapter = new OfficialLarkRegistrationAdapter((async (options) => {
      sdkOptions = options as unknown as Record<string, unknown>;
      options.onQRCodeReady({
        url: "https://accounts.feishu.cn/qr/sdk",
        expireIn: 60,
      });
      return {
        client_id: "cli_sdk1",
        client_secret: "sdk-secret",
      };
    }) as never);
    const controller = new AbortController();
    const result = await adapter.register({
      createOnly: true,
      config: requestedConfig,
      signal: controller.signal,
      onQrCode: () => {},
      onStatus: () => {},
    });
    expect(result.clientId).toBe("cli_sdk1");
    expect(sdkOptions).toMatchObject({
      createOnly: true,
      source: "omem",
      appPreset: requestedConfig.appPreset,
      addons: requestedConfig.addons,
    });

    const x = setup();
    const started = await x.service.start({
      mode: "new",
      config: requestedConfig,
    });
    expect(started).toMatchObject({
      mode: "new",
      status: "awaiting_scan",
      qrUrl: "https://accounts.feishu.cn/qr/fixture",
      appId: null,
    });
    expect(x.registration.requests[0]).toMatchObject({
      createOnly: true,
      appId: undefined,
      config: requestedConfig,
    });
  });

  it("A-L02 keeps cancellation/denial/expiry terminal and ignores late credentials", async () => {
    const cancelled = setup();
    const started = await cancelled.service.start({
      mode: "new",
      config: requestedConfig,
    });
    cancelled.service.cancel(started.id);
    cancelled.registration.complete({
      clientId: "cli_late1",
      clientSecret: "late-secret",
    });
    await cancelled.service.wait(started.id);
    expect(cancelled.service.status(started.id)).toMatchObject({
      status: "cancelled",
      appId: "cli_late1",
      errorCode: "late_credentials_needs_review",
    });
    expect(cancelled.service.connections()).toEqual([]);
    expect(readdirSync(join(cancelled.directory, "secrets"))).toEqual([]);

    for (const code of ["access_denied", "expired_token"]) {
      const x = setup();
      const pending = await x.service.start({
        mode: "new",
        config: requestedConfig,
      });
      x.registration.fail(code);
      await x.service.wait(pending.id);
      expect(x.service.status(pending.id).status).toBe(
        code === "access_denied" ? "denied" : "expired",
      );
      expect(x.service.connections()).toEqual([]);
    }
  });

  it("A-L03 treats credentials as unverified until actual capability checks pass", async () => {
    const x = setup(
      new FakeRegistration(),
      new FakeProbe({
        actual: {
          scopes: ["im:message:send_as_bot"],
          events: [],
          callbacks: [],
        },
        missing: ["im.message.receive_v1", "card.action.trigger"],
        repairHint: "Enable event and callback in developer console.",
      }),
    );
    const status = await ready(x);
    expect(status).toMatchObject({
      status: "failed",
      appId: "cli_test1",
      missingCapabilities: ["card.action.trigger", "im.message.receive_v1"],
      errorCode: "missing_capabilities",
    });
    expect(x.service.connections()).toMatchObject([
      { appId: "cli_test1", state: "failed", activeVersion: null },
    ]);
    const states = x.store.db
      .prepare(
        "SELECT status FROM lark_onboarding_events WHERE onboarding_id=? ORDER BY rowid",
      )
      .all(status.id)
      .map((row) => String((row as { status: string }).status));
    expect(states).toEqual([
      "draft",
      "awaiting_scan",
      "credentials_received",
      "checking",
      "failed",
    ]);
  });

  it("A-L04 stores client_secret only as encrypted owner-only data", async () => {
    const x = setup();
    const clientSecret = "never-log-this-client-secret";
    const status = await ready(x, {
      clientId: "cli_secret1",
      clientSecret,
      userInfo: { tenantBrand: "feishu" },
    });
    expect(JSON.stringify(status)).not.toContain(clientSecret);
    expect(JSON.stringify(x.service.connections())).not.toContain(clientSecret);
    const version = x.store.db
      .prepare("SELECT * FROM lark_connection_versions")
      .get() as { secret_ref: string };
    expect(version.secret_ref).toMatch(/^lark:/);
    const files = readdirSync(join(x.directory, "secrets"));
    expect(files).toHaveLength(1);
    const path = join(x.directory, "secrets", files[0]!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain(clientSecret);
    expect(x.secrets.get(version.secret_ref)).toEqual({
      appId: "cli_secret1",
      clientSecret,
    });
    const databaseRows = JSON.stringify([
      ...x.store.db.prepare("SELECT * FROM lark_onboardings").all(),
      ...x.store.db.prepare("SELECT * FROM lark_connections").all(),
      ...x.store.db.prepare("SELECT * FROM lark_connection_versions").all(),
    ]);
    expect(databaseRows).not.toContain(clientSecret);
  });

  it("A-L05 requires same-app pairing even when registration returns user_info", async () => {
    const x = setup();
    const status = await ready(x);
    expect(status).toMatchObject({
      status: "awaiting_pair",
      userInfo: { openId: "ou_scan_user", tenantBrand: "feishu" },
      ownerOpenId: null,
      activeVersion: null,
    });
    expect(x.store.db.prepare("SELECT * FROM lark_bindings").all()).toEqual([]);
  });

  it("A-L06 enforces long-lived random pairing, app/actor binding, expiry and one-time use", async () => {
    let clock = new Date("2026-09-27T00:00:00.000Z");
    const x = setup(new FakeRegistration(), new FakeProbe(), () => clock);
    const status = await ready(x);
    const expired = x.service.issuePairingCode(status.id, 100);
    expect(
      Buffer.from(expired.code, "base64url").length,
    ).toBeGreaterThanOrEqual(16);
    clock = new Date(clock.getTime() + 101);
    expect(() =>
      x.service.receivePairing({
        appId: "cli_test1",
        code: expired.code,
        senderOpenId: "ou_owner1",
        chatId: "oc_chat1",
        chatType: "p2p",
      }),
    ).toThrow("LARK_PAIRING_EXPIRED");

    const pairing = x.service.issuePairingCode(status.id);
    expect(() =>
      x.service.receivePairing({
        appId: "cli_other1",
        code: pairing.code,
        senderOpenId: "ou_owner1",
        chatId: "oc_chat1",
        chatType: "p2p",
      }),
    ).toThrow("LARK_PAIRING_APP_MISMATCH");
    expect(() =>
      x.service.receivePairing({
        appId: "cli_test1",
        code: "wrong-code-that-is-long-enough",
        senderOpenId: "ou_owner1",
        chatId: "oc_chat1",
        chatType: "p2p",
      }),
    ).toThrow("LARK_PAIRING_CODE_INVALID");
    const matched = x.service.receivePairing({
      appId: "cli_test1",
      code: pairing.code,
      senderOpenId: "ou_owner1",
      chatId: "oc_chat1",
      chatType: "p2p",
    });
    expect(() =>
      x.service.receivePairing({
        appId: "cli_test1",
        code: pairing.code,
        senderOpenId: "ou_attacker1",
        chatId: "oc_other1",
        chatType: "p2p",
      }),
    ).toThrow("LARK_PAIRING_ACTOR_MISMATCH");
    expect(() =>
      x.service.confirmPairing({
        pairingId: matched.pairingId,
        expectedOpenId: "ou_wrong1",
      }),
    ).toThrow("LARK_PAIRING_ACTOR_MISMATCH");
    expect(
      x.service.confirmPairing({
        pairingId: matched.pairingId,
        expectedOpenId: "ou_owner1",
      }),
    ).toMatchObject({ bindingVersion: 1, ownerOpenId: "ou_owner1" });
    expect(() =>
      x.service.confirmPairing({
        pairingId: matched.pairingId,
        expectedOpenId: "ou_owner1",
      }),
    ).toThrow("LARK_PAIRING_ALREADY_CONSUMED");
  });

  it("A-L07 stages existing-app updates and switches binding versions only after confirmation", async () => {
    const x = setup();
    const firstStatus = await ready(x, {
      clientId: "cli_existing1",
      clientSecret: "first-secret",
      userInfo: { tenantBrand: "feishu" },
    });
    const firstCode = x.service.issuePairingCode(firstStatus.id);
    const firstPair = x.service.receivePairing({
      appId: "cli_existing1",
      code: firstCode.code,
      senderOpenId: "ou_owner1",
      chatId: "oc_p2p1",
      chatType: "p2p",
    });
    x.service.confirmPairing({
      pairingId: firstPair.pairingId,
      expectedOpenId: "ou_owner1",
    });

    const updateRegistration = new FakeRegistration();
    const updateService = new LarkOnboardingService(
      x.store.db,
      x.secrets,
      updateRegistration,
      new FakeProbe(),
      () => new Date("2026-09-27T01:00:00.000Z"),
    );
    const pending = await updateService.start({
      mode: "existing",
      appId: "cli_existing1",
      config: requestedConfig,
    });
    expect(updateRegistration.requests[0]).toMatchObject({
      createOnly: false,
      appId: "cli_existing1",
    });
    updateRegistration.complete({
      clientId: "cli_existing1",
      clientSecret: "second-secret",
      userInfo: { tenantBrand: "feishu" },
    });
    const staged = await updateService.wait(pending.id);
    expect(staged).toMatchObject({
      status: "awaiting_pair",
      connectionVersion: 2,
      activeVersion: 1,
      ownerOpenId: "ou_owner1",
    });
    const secondCode = updateService.issuePairingCode(staged.id);
    const secondPair = updateService.receivePairing({
      appId: "cli_existing1",
      code: secondCode.code,
      senderOpenId: "ou_owner1",
      chatId: "oc_group2",
      chatType: "group",
    });
    const rebound = updateService.confirmPairing({
      pairingId: secondPair.pairingId,
      expectedOpenId: "ou_owner1",
    });
    expect(rebound).toMatchObject({
      bindingVersion: 2,
      targetChatId: "oc_group2",
      targetType: "group",
    });
    expect(updateService.connections()).toMatchObject([
      { appId: "cli_existing1", state: "active", activeVersion: 2 },
    ]);
    expect(
      x.store.db
        .prepare(
          "SELECT binding_version AS version,state,target_chat_id AS target FROM lark_bindings ORDER BY binding_version",
        )
        .all(),
    ).toEqual([
      { version: 1, state: "superseded", target: "oc_p2p1" },
      { version: 2, state: "active", target: "oc_group2" },
    ]);
    expect(
      x.store.db
        .prepare(
          "SELECT version,state FROM lark_connection_versions ORDER BY version",
        )
        .all(),
    ).toEqual([
      { version: 1, state: "superseded" },
      { version: 2, state: "active" },
    ]);
  });
});
