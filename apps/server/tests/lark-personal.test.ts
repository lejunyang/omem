import { it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { PersonalLarkService } from "../src/integrations/lark-personal/service.js";
import type {
  PersonalLarkPort,
  LarkMessage,
} from "../src/integrations/lark-personal/client.js";
import { messageMaterial } from "../src/integrations/lark-personal/materials.js";
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.forEach((s) => s.close());
  stores.length = 0;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function store() {
  const d = mkdtempSync(join(tmpdir(), "omem-personal-test-"));
  dirs.push(d);
  const s = new Store(d);
  stores.push(s);
  return s;
}
const m = (id: string, chat = "oc_a"): LarkMessage => ({
  message_id: id,
  chat_id: chat,
  msg_type: "text",
  content: "请周三前确认新需求。",
  create_time: new Date().toISOString(),
  sender: { id: "ou_b", name: "同事" },
});
const decisions = {
  decide: async () => null,
  status: () => ({
    status: "unavailable",
    model: "",
    lastError: "",
    mode: "auto",
  }),
};
function port(overrides: Partial<PersonalLarkPort> = {}): PersonalLarkPort {
  return {
    identity: async () => "ou_owner",
    chats: async () => ({
      chats: [{ chat_id: "oc_a", name: "需求群", chat_mode: "group" }],
      has_more: false,
    }),
    preferences: async (ids) =>
      ids.map((chat_id) => ({
        chat_id,
        is_muted: false,
        is_mute_at_all: false,
      })),
    messages: async () => ({ messages: [], has_more: false }),
    resource: async () => {
      throw Error("download unavailable");
    },
    ...overrides,
  };
}
it("keeps pagination across restart and falls back to Agent investigation without creating tasks when decisions are unavailable", async () => {
  const s = store();
  let calls = 0;
  const p = port({
    messages: async (input) => {
      calls++;
      return input.token
        ? { messages: [m("om_2")], has_more: false }
        : { messages: [m("om_1")], has_more: true, page_token: "next" };
    },
  });
  let service = new PersonalLarkService(s, decisions, p);
  await service.discover();
  service.subscribe("oc_a", "watch");
  service.configure({ enabled: true, mentionExceptions: false });
  await service.processOnce();
  expect(
    s.db
      .prepare("SELECT page_token FROM personal_lark_streams WHERE id='oc_a'")
      .get()?.page_token,
  ).toBe("next");
  service = new PersonalLarkService(s, decisions, p);
  await service.processOnce();
  expect(calls).toBe(2);
  expect(service.inbox()).toHaveLength(2);
  expect(s.db.prepare("SELECT count(*) AS n FROM tasks").get()?.n).toBe(0);
  expect(
    s.db
      .prepare("SELECT count(*) AS n FROM jobs WHERE kind='extract_claims'")
      .get()?.n,
  ).toBe(2);
  expect(s.db.prepare("SELECT count(*) AS n FROM notifications").get()?.n).toBe(
    0,
  );
});
it("skips ordinary muted streams but preserves mentions, honoring explicit exclusions and mute-all", async () => {
  const s = store();
  let normal = 0;
  const p = port({
    preferences: async (ids) =>
      ids.map((chat_id) => ({ chat_id, is_muted: true, is_mute_at_all: true })),
    messages: async (input) => {
      if (input.chatId) {
        normal++;
        return { messages: [], has_more: false };
      }
      return {
        messages: [
          { ...m("om_direct"), mentions: [{ id: "ou_owner" }] },
          { ...m("om_all"), mentions: [{ id: "all" }] },
          m("om_excluded", "oc_x"),
        ],
        has_more: false,
      };
    },
  });
  const service = new PersonalLarkService(s, decisions, p);
  await service.discover();
  s.db
    .prepare(
      "INSERT INTO personal_lark_streams(id,name,mode,next_at) VALUES('oc_x','排除群','excluded','1970-01-01T00:00:00.000Z')",
    )
    .run();
  service.subscribe("oc_a", "watch");
  service.configure({ enabled: true });
  await service.processOnce();
  await service.processOnce();
  expect(normal).toBe(0);
  expect(service.inbox().map((i) => i.id)).toEqual(["om_direct"]);
});
it("saves attachment failure explicitly and passes real images to the common capture path", async () => {
  const s = store();
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZsAAAAASUVORK5CYII=",
    "base64",
  );
  const r = await messageMaterial(
    s,
    port({
      resource: async (_, key) => {
        if (key === "img_good") return image;
        throw Error("附件不可访问");
      },
    }),
    {
      ...m("om_media"),
      content: '![截图](img_good) <file key="file_bad" name="说明.pdf"/>',
    },
    "需求群",
    "ou_owner",
    true,
  );
  expect(r.input.parts.some((p) => p.type === "image")).toBe(true);
  expect(r.resources.find((r) => r.kind === "file")).toMatchObject({
    status: "failed",
    error: "附件不可访问",
  });
  const captured = s.capture(r.input, { learning: false, notify: false });
  expect(captured.revision.parts.some((p) => p.type === "image")).toBe(true);
});
