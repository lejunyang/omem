import { queueOwnerNotice } from "../lark/owner-notice.js";
import { randomUUID } from "node:crypto";
import type { Store } from "../../store.js";
import type { DecisionService } from "../../decision/service.js";
import { stableDigest } from "../../storage/digest.js";
import { DurableJobWorker, JobExecutionError } from "../../jobs/worker.js";
import type { JobLease } from "../../jobs/repository.js";
import { captureSchema } from "../../../../../packages/contracts/src/index.js";
import {
  PersonalLarkClient,
  type PersonalLarkPort,
  type LarkMessage,
} from "./client.js";
import { personalLarkSettingsSchema, messageQuestions } from "./policy.js";
import { messageMaterial, messageTime } from "./materials.js";
type Row = Record<string, any>;
export class PersonalLarkService {
  private worker: DurableJobWorker;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<unknown>;
  private stopped = false;
  constructor(
    readonly store: Store,
    private decisions: Pick<DecisionService, "decide" | "status">,
    private port: PersonalLarkPort = new PersonalLarkClient(store.dataDir),
  ) {
    const hash = stableDigest({ version: "lark-personal@1" });
    this.worker = new DurableJobWorker(
      store.jobs,
      `lark-personal-${randomUUID()}`,
      {
        lark_personal_sync: (job) => this.sync(job),
        lark_personal_retry: (job) => this.retryJob(job),
      },
      {
        kinds: ["lark_personal_sync", "lark_personal_retry"],
        fingerprint: () => ({
          model: null,
          effort: null,
          promptHash: hash,
          skillHash: hash,
          toolHash: hash,
        }),
      },
    );
  }
  settings() {
    return personalLarkSettingsSchema.parse(
      JSON.parse(
        String(
          this.store.db
            .prepare("SELECT value FROM personal_lark_settings WHERE id=1")
            .get()!.value,
        ),
      ),
    );
  }
  configure(value: unknown) {
    const settings = personalLarkSettingsSchema.parse(value);
    this.store.db
      .prepare("UPDATE personal_lark_settings SET value=? WHERE id=1")
      .run(JSON.stringify(settings));
    return settings;
  }
  health() {
    const streams = this.streams() as Row[];
    return {
      enabled: this.settings().enabled,
      running: !!this.active,
      subscriptions: streams.filter((s) => s.mode === "watch").length,
      failedStreams: streams.filter((s) => s.last_error).length,
      lastSuccess:
        streams
          .map((s) => s.last_success)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
      decisions: this.decisions.status().status,
    };
  }
  status() {
    const counts = this.store.db
      .prepare(
        "SELECT state,count(*) AS count FROM personal_lark_messages GROUP BY state",
      )
      .all();
    return {
      settings: this.settings(),
      running: !!this.active,
      decisions: this.decisions.status(),
      streams: this.streams(),
      messages: counts,
    };
  }
  streams() {
    return this.store.db
      .prepare(
        "SELECT * FROM personal_lark_streams ORDER BY id='@mentions' DESC,name",
      )
      .all();
  }
  async discover() {
    const result = await this.port.chats();
    for (const c of result.chats)
      this.store.db
        .prepare(
          `INSERT INTO personal_lark_streams(id,name,kind,next_at) VALUES(?,?,?,'1970-01-01T00:00:00.000Z')
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind`,
        )
        .run(c.chat_id, c.name || "未命名会话", c.chat_mode);
    return { ...result, streams: this.streams() };
  }
  subscribe(id: string, mode: "watch" | "off" | "excluded") {
    if (!/^oc_[A-Za-z0-9]+$/.test(id)) throw Error("请选择已经发现的会话");
    const r = this.store.db
      .prepare("UPDATE personal_lark_streams SET mode=?,next_at=? WHERE id=?")
      .run(mode, new Date().toISOString(), id);
    if (!r.changes) throw Error("会话不在当前列表中");
    return this.streams();
  }
  inbox() {
    return this.store.db
      .prepare(
        "SELECT id,chat_id,chat_name,raw,revision_id,decision,resources,state,error,observed_at FROM personal_lark_messages ORDER BY observed_at DESC LIMIT 200",
      )
      .all()
      .map((r) => {
        const raw = JSON.parse(String(r.raw)) as LarkMessage;
        return {
          ...r,
          raw: undefined,
          text: raw.content,
          sender: raw.sender?.name,
          link: raw.message_app_link,
          decision: r.decision ? JSON.parse(String(r.decision)) : null,
          resources: JSON.parse(String(r.resources)),
        };
      });
  }
  schedule(force = false) {
    const settings = this.settings();
    if (!settings.enabled) return { queued: 0 };
    let queued = 0;
    const now = new Date().toISOString();
    for (const s of this.streams() as Row[]) {
      if (
        !(
          s.mode === "watch" ||
          (s.id === "@mentions" && settings.mentionExceptions)
        )
      )
        continue;
      if (!force && s.next_at > now) continue;
      const existing = this.store.db
        .prepare(
          `SELECT 1 FROM jobs WHERE kind='lark_personal_sync' AND state IN ('queued','leased','running','retry_wait')
        AND json_extract(input_refs,'$[0].streamId')=?`,
        )
        .get(s.id);
      if (existing) continue;
      // Freeze the end of the window until all pages have been committed.
      const start =
        s.watermark ||
        new Date(Date.now() - settings.historyHours * 3600000).toISOString();
      const end = s.window_end || now;
      const ref = {
        streamId: s.id,
        start,
        end,
        token: s.page_token || null,
        occurrence: now,
      };
      this.store.jobs.enqueue({
        kind: "lark_personal_sync",
        inputRefs: [ref],
        roleVersion: "readonly-cli@1",
        policyVersion: "personal-lark@1",
        maxAttempts: 3,
      });
      queued++;
      this.store.db
        .prepare(
          "UPDATE personal_lark_streams SET window_end=?,next_at=? WHERE id=?",
        )
        .run(
          end,
          new Date(Date.now() + settings.intervalMinutes * 60000).toISOString(),
          s.id,
        );
    }
    return { queued };
  }
  private notify(title: string, body: string) {
    this.store.tx(() => {
      const change = this.store.record("integration", title, null, null, body);
      queueOwnerNotice(
        this.store.db,
        change,
        title,
        body,
        new Date().toISOString(),
      );
    });
  }
  async sync(job: JobLease) {
    const ref = job.inputRefs[0] as {
      streamId: string;
      start: string;
      end: string;
      token: string | null;
    };
    const stream = this.store.db
      .prepare("SELECT * FROM personal_lark_streams WHERE id=?")
      .get(ref.streamId) as Row;
    const settings = this.settings();
    if (
      !settings.enabled ||
      !stream ||
      (stream.mode !== "watch" &&
        !(stream.id === "@mentions" && settings.mentionExceptions))
    )
      return {};
    try {
      const ownerId = await this.port.identity();
      const owner = this.store.db
        .prepare("SELECT owner_id FROM personal_lark_settings WHERE id=1")
        .get()!.owner_id;
      if (owner && owner !== ownerId)
        throw Error("飞书登录用户已变化，请先确认采集身份，当前同步已暂停");
      this.store.db
        .prepare("UPDATE personal_lark_settings SET owner_id=? WHERE id=1")
        .run(ownerId);
      if (stream.id !== "@mentions" && stream.kind !== "p2p") {
        const pref = (await this.port.preferences([stream.id])).find(
          (p) => p.chat_id === stream.id,
        );
        if (!pref) throw Error("无法确认群聊免打扰状态，暂缓普通消息采集");
        if (pref.is_muted) {
          // Do not backfill the muted period when this group becomes active again.
          // Mentions have their own cursor and still run independently.
          this.store.db
            .prepare(
              "UPDATE personal_lark_streams SET watermark=?,window_end=NULL,page_token=NULL WHERE id=?",
            )
            .run(ref.end, stream.id);
          return {};
        }
      }
      const page = await this.port.messages({
        ownerId,
        chatId: stream.id === "@mentions" ? undefined : stream.id,
        start: ref.start,
        end: ref.end,
        token: ref.token ?? undefined,
      });
      const prefs =
        stream.id === "@mentions"
          ? await this.port.preferences([
              ...new Set(page.messages.map((m) => m.chat_id)),
            ])
          : [];
      const selected = page.messages.filter((m) => {
        if (stream.id !== "@mentions") return true;
        const direct = m.mentions?.some((v) => v.id === ownerId);
        const all =
          m.mentions?.some((v) => v.id === "all") ||
          /user_id=["']all["']|@所有人|@all\b/.test(m.content);
        return (
          direct ||
          !all ||
          !prefs.find((p) => p.chat_id === m.chat_id)?.is_mute_at_all
        );
      });
      const all = selected.flatMap((m) => [
        m,
        ...(m.thread_replies ?? []).map((r) => ({
          ...r,
          chat_id: r.chat_id || m.chat_id,
          thread_id: r.thread_id || m.thread_id,
        })),
      ]);
      for (const m of all) {
        if (!this.settings().enabled) return {};
        if (
          this.store.db
            .prepare(
              "SELECT 1 FROM personal_lark_streams WHERE id=? AND mode='excluded'",
            )
            .get(m.chat_id)
        )
          continue;
        await this.processMessage(
          m,
          m.chat_name ||
            (stream.id === "@mentions" ? "提及所在会话" : stream.name),
          ownerId,
        );
      }
      if (page.has_more && !page.page_token)
        throw Error("飞书返回还有消息但缺少分页游标，未推进同步位置");
      this.store.db
        .prepare(
          `UPDATE personal_lark_streams SET watermark=?,window_end=?,page_token=?,next_at=?,last_success=?,last_error=NULL WHERE id=?`,
        )
        .run(
          page.has_more
            ? ref.start
            : new Date(new Date(ref.end).getTime() - 60_000).toISOString(),
          page.has_more ? ref.end : null,
          page.has_more ? page.page_token! : null,
          page.has_more
            ? new Date().toISOString()
            : new Date(
                Date.now() + settings.intervalMinutes * 60000,
              ).toISOString(),
          new Date().toISOString(),
          stream.id,
        );
      if (stream.last_error)
        this.notify(
          "飞书消息同步已恢复",
          "消息采集已恢复，将从保存的位置继续处理。",
        );
      return {};
    } catch (e) {
      const message = e instanceof Error ? e.message : "飞书同步失败";
      this.store.db
        .prepare("UPDATE personal_lark_streams SET last_error=? WHERE id=?")
        .run(message.slice(0, 500), ref.streamId);
      if (!stream.last_error)
        this.notify(
          "飞书消息同步需要处理",
          `${message}。已保留同步位置，可在飞书消息页检查和重试。`,
        );
      throw new JobExecutionError(
        message,
        /身份|登录|权限/.test(message) ? "auth" : "transient",
      );
    }
  }
  private async processMessage(
    m: LarkMessage,
    name: string,
    ownerId: string,
    force = false,
  ) {
    const settings = this.settings();
    const digest = stableDigest(m);
    const previous = this.store.db
      .prepare("SELECT * FROM personal_lark_messages WHERE id=?")
      .get(m.message_id) as Row | undefined;
    if (
      !force &&
      previous?.digest === digest &&
      ["ready", "review"].includes(previous.state)
    )
      return;
    const at = new Date().toISOString();
    this.store.db
      .prepare(
        `INSERT INTO personal_lark_messages(id,chat_id,chat_name,digest,raw,observed_at,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,raw=excluded.raw,state='pending',error=NULL,decision=NULL,updated_at=excluded.updated_at`,
      )
      .run(
        m.message_id,
        m.chat_id,
        name,
        digest,
        JSON.stringify(m),
        messageTime(m.create_time),
        at,
      );
    // Each original message survives even if downloading or parsing an attachment fails.
    try {
      const material = await messageMaterial(
        this.store,
        this.port,
        m,
        name,
        ownerId,
        settings.resources,
      );
      const capture = this.store.capture(captureSchema.parse(material.input), {
        learning: false,
        notify: false,
      });
      const neighbors = this.store.db
        .prepare(
          "SELECT raw FROM personal_lark_messages WHERE chat_id=? AND observed_at<=? AND id<>? ORDER BY observed_at DESC LIMIT 8",
        )
        .all(m.chat_id, messageTime(m.create_time), m.message_id)
        .reverse()
        .map((r) => JSON.parse(String(r.raw)));
      const result = await this.decisions.decide(
        {
          ownerId,
          conversation: name,
          current: m,
          previousMessages: neighbors,
          tasks: this.store.db
            .prepare(
              "SELECT title,status,next_step FROM tasks WHERE status IN ('open','waiting') LIMIT 30",
            )
            .all(),
          resources: material.resources,
          material: material.input.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text),
          imagesAvailableForVisionAgent: material.input.parts.some(
            (p) => p.type === "image",
          ),
        },
        messageQuestions,
      );
      const a = result?.answers;
      const incomplete =
        material.resources.some(
          (r) =>
            r.status === "failed" ||
            (r.status === "saved" &&
              !(
                r.kind === "image" &&
                material.input.parts.some((p) => p.type === "image")
              )),
        ) ||
        m.thread_has_more ||
        !!m.thread_replies_error;
      const suspicious = a?.injection?.choice === "attempt";
      const lowPriority =
        a?.attention?.choice === "noise" &&
        a.attention.confidence >= 0.85 &&
        !material.resources.length;
      const needsLearning =
        !suspicious && !lowPriority && !m.deleted && !incomplete;
      // Reuse memory extraction and independent verification, never create tasks from classifier labels.
      if (needsLearning)
        this.store.capture(captureSchema.parse(material.input), {
          notify: false,
        });
      this.store.db
        .prepare(
          "UPDATE personal_lark_messages SET revision_id=?,decision=?,resources=?,state=?,error=? WHERE id=?",
        )
        .run(
          capture.revision.id,
          result ? JSON.stringify(result) : null,
          JSON.stringify(material.resources),
          result && !incomplete && !suspicious ? "ready" : "review",
          suspicious
            ? "包含可疑指令，保留原文但未自动整理"
            : incomplete
            ? "部分资源或话题尚未读全"
            : !result
              ? "决策模型未运行，完整材料已排队等待 Agent 整理"
              : null,
          m.message_id,
        );
    } catch (e) {
      this.store.db
        .prepare(
          "UPDATE personal_lark_messages SET state='failed',error=? WHERE id=?",
        )
        .run(
          String(e instanceof Error ? e.message : e).slice(0, 500),
          m.message_id,
        );
    }
  }
  retry(id: string) {
    if (
      !this.store.db
        .prepare("SELECT 1 FROM personal_lark_messages WHERE id=?")
        .get(id)
    )
      throw Error("消息不存在");
    return this.store.jobs.enqueue({
      kind: "lark_personal_retry",
      inputRefs: [{ messageId: id, at: new Date().toISOString() }],
      roleVersion: "message-reading@1",
      policyVersion: "personal-lark@1",
      maxAttempts: 1,
    });
  }
  private async retryJob(job: JobLease) {
    const id = (job.inputRefs[0] as { messageId: string }).messageId;
    const row = this.store.db
      .prepare("SELECT * FROM personal_lark_messages WHERE id=?")
      .get(id) as Row;
    if (
      !row ||
      this.store.db
        .prepare(
          "SELECT 1 FROM personal_lark_streams WHERE id=? AND mode='excluded'",
        )
        .get(row.chat_id)
    )
      return {};
    const ownerId = await this.port.identity();
    const owner = this.store.db
      .prepare("SELECT owner_id FROM personal_lark_settings WHERE id=1")
      .get()!.owner_id;
    if (owner && owner !== ownerId)
      throw new JobExecutionError("飞书个人登录身份已变化", "auth");
    await this.processMessage(
      JSON.parse(row.raw),
      row.chat_name,
      ownerId,
      true,
    );
    return {};
  }
  async processOnce() {
    this.schedule();
    return this.worker.processOne();
  }
  start() {
    const tick = () => {
      if (this.stopped) return;
      this.active = this.processOnce()
        .catch(() => undefined)
        .finally(() => {
          this.active = undefined;
          if (!this.stopped) {
            this.timer = setTimeout(tick, 1000);
            this.timer.unref();
          }
        });
    };
    tick();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.worker.stop();
    await this.active;
  }
}
