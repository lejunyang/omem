import { join } from "node:path";
import { writeFile, rename } from "node:fs/promises";

export default function register(api) {
  const dir = process.env.OMEM_PLUGIN_DATA;
  if (!dir) throw new Error("请用隔离模式运行文件通知示例");
  const subject = { provider: "local-demo", subject: "operator" };
  async function write(ref, content, signal) {
    // The host creates the keys. Use a temporary file so readers only see complete messages.
    const file = join(dir, encodeURIComponent(ref) + ".json");
    const temp = file + "." + crypto.randomUUID();
    await writeFile(temp, JSON.stringify(content, null, 2), { signal, mode: 0o600 });
    await rename(temp, file);
  }
  const deliver = async (n, signal) => {
    await write(n.dedupKey, n, signal);
    return { ref: n.dedupKey };
  };
  api.notifier({
    id: "file", name: "本机文件",
    async resolve(user) {
      const ok = user.id === "owner" && user.identities.some(i => i.provider === subject.provider && i.subject === subject.subject);
      return ok ? { ok } : { ok, hint: "给本人绑定 local-demo 的 operator 身份" };
    },
    deliver, ask: deliver, update: write,
    async retract(ref, signal) { await write(ref, { closed: true }, signal); },
  });
  // A signed-in click stands in for a platform-authenticated callback in this demo.
  api.tool({
    name: "localnotice_answer", description: "模拟本机使用者点击一个选项", page: true, write: true,
    schema: api.z.object({ ref: api.z.string(), choice: api.z.number().int().nonnegative() }),
    async handler(ctx, input) {
      if (ctx.actor !== "user" || ctx.userId !== "owner") throw new Error("只接受本人手动试答");
      await api.answerAsk({ notifier: "file", user: subject, ...input });
      return "已提交";
    },
  });
}
