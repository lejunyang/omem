import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, realpath, stat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
const exec = promisify(execFile);
export type LarkMessage = {
  message_id: string;
  chat_id: string;
  chat_name?: string;
  msg_type: string;
  content: string;
  create_time: string;
  update_time?: string;
  updated?: boolean;
  deleted?: boolean;
  message_app_link?: string;
  sender?: { id?: string; name?: string; sender_type?: string };
  mentions?: { id: string; name?: string }[];
  thread_id?: string;
  thread_replies?: LarkMessage[];
  thread_has_more?: boolean;
  thread_replies_error?: string;
};
export type LarkChat = { chat_id: string; name: string; chat_mode: string };
export type MessagePage = {
  messages: LarkMessage[];
  has_more: boolean;
  page_token?: string;
};
export interface PersonalLarkPort {
  identity(): Promise<string>;
  preferences(
    ids: string[],
  ): Promise<{ chat_id: string; is_muted: boolean; is_mute_at_all: boolean }[]>;
  chats(): Promise<{ chats: LarkChat[]; filter?: unknown; has_more: boolean }>;
  messages(input: {
    chatId?: string;
    ownerId: string;
    start: string;
    end: string;
    token?: string;
    order?: "asc" | "desc";
    limit?: number;
  }): Promise<MessagePage>;
  resource(
    messageId: string,
    key: string,
    type: "image" | "file",
  ): Promise<Buffer>;
}
/** Deliberately no generic command or send/read-ack method on this port. */
export class PersonalLarkClient implements PersonalLarkPort {
  constructor(private dataDir: string) {}
  private async call(args: string[], cwd = this.dataDir): Promise<any> {
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    try {
      const { stdout } = await exec(
        process.execPath,
        [
          createRequire(import.meta.url).resolve(
            "@larksuite/cli/scripts/run.js",
          ),
          ...args,
        ],
        { cwd, timeout: 90_000, maxBuffer: 15_000_000 },
      );
      const value = JSON.parse(stdout);
      if (value.ok === false)
        throw Error(value.error?.message || "飞书读取失败");
      return value;
    } catch (e) {
      const raw = String((e as { stderr?: string }).stderr ?? "");
      let message = e instanceof Error ? e.message : "飞书读取失败";
      try {
        const error = JSON.parse(raw).error;
        message = `${error.code ?? ""} ${error.message ?? "读取失败"}`;
      } catch {
        /* Never publish command lines or credentials. */
      }
      if (/keychain|auth|login|credential|token|999916/i.test(raw))
        message =
          "飞书登录或权限不可用，请在服务所在电脑检查 lark-cli 登录状态";
      throw Error(
        message.includes("Command failed")
          ? "飞书 CLI 读取失败，请检查登录和网络"
          : message.slice(0, 300),
      );
    }
  }
  async identity() {
    const v = await this.call(["auth", "status", "--json", "--verify"]);
    const id = (v.data ?? v).identities?.user?.openId;
    if (typeof id !== "string" || !/^ou_/.test(id))
      throw Error("没有可用的飞书个人登录身份");
    return id;
  }
  async chats() {
    const v = await this.call([
      "im",
      "+chat-list",
      "--as",
      "user",
      "--types",
      "p2p,group",
      "--sort",
      "active_time",
      "--exclude-muted",
      "--page-size",
      "100",
      "--page-all",
      "--page-limit",
      "3",
      "--format",
      "json",
    ]);
    return v.data;
  }
  async preferences(ids: string[]) {
    const items: {
      chat_id: string;
      is_muted: boolean;
      is_mute_at_all: boolean;
    }[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const v = await this.call([
        "im",
        "chat.user_setting",
        "batch_query",
        "--data",
        JSON.stringify({ chat_ids: ids.slice(i, i + 10) }),
        "--as",
        "user",
        "--format",
        "json",
      ]);
      if (!Array.isArray(v.data?.items)) throw Error("无法读取群聊免打扰设置");
      items.push(...v.data.items);
    }
    return items;
  }
  async messages(input: {
    chatId?: string;
    ownerId: string;
    start: string;
    end: string;
    token?: string;
    order?: "asc" | "desc";
    limit?: number;
  }): Promise<MessagePage> {
    // The upstream search API rejects fractional seconds in some CLI versions.
    const time = (s: string) =>
      new Date(s).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const args = input.chatId
      ? [
          "+chat-messages-list",
          "--chat-id",
          input.chatId,
          "--order",
          input.order ?? "asc",
        ]
      : [
          "+messages-search",
          "--at-chatter-ids",
          input.ownerId,
          "--chat-type",
          "group",
        ];
    const v = await this.call([
      "im",
      ...args,
      "--start",
      time(input.start),
      "--end",
      time(input.end),
      "--page-size",
      String(Math.max(1, Math.min(50, input.limit ?? 50))),
      "--no-reactions",
      ...(input.token ? ["--page-token", input.token] : []),
      "--as",
      "user",
      "--format",
      "json",
    ]);
    if (!Array.isArray(v.data?.messages)) throw Error("飞书返回缺少消息列表");
    return v.data;
  }
  async resource(messageId: string, key: string, type: "image" | "file") {
    const dir = await mkdtemp(join(this.dataDir, "lark-resource-"));
    try {
      const response = await this.call(
        [
          "im",
          "+messages-resources-download",
          "--message-id",
          messageId,
          "--file-key",
          key,
          "--type",
          type,
          "--output",
          "resource",
          "--as",
          "user",
          "--format",
          "json",
        ],
        dir,
      );
      const saved = response.data?.saved_path;
      if (typeof saved !== "string") throw Error("附件响应缺少保存位置");
      const path = await realpath(resolve(dir, saved));
      const local = relative(await realpath(dir), path);
      if (local.startsWith("..") || isAbsolute(local))
        throw Error("附件保存位置超出临时目录");
      if ((await stat(path)).size > 20_000_000)
        throw Error("附件超过 20 MB，需单独导入");
      return await readFile(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
