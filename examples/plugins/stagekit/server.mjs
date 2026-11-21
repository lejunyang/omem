import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const filename = { type: "object", properties: { file: { type: "string", pattern: "^[a-z0-9-]+\\.txt$" } }, required: ["file"], additionalProperties: false };
export default function register(api) {
  const data = process.env.OMEM_PLUGIN_DATA;
  api.flowSignal({
    id: "mark", name: "文件标记", describe: "文件里的标记是 ready 就算完成", params: filename,
    async check(ctx, signal) {
      let mark;
      try { mark = await readFile(join(data, ctx.with.file), { encoding: "utf8", signal }); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      return { done: mark?.trim() === "ready", waitingOn: "等文件标记 ready", recheckAfterSec: 30,
        evidence: mark?.trim() === "ready" ? [{ text: `文件 ${ctx.with.file} 的标记是 ready` }] : [] };
    },
  });
  api.stageRunner({
    id: "write", name: "写检查文件", describe: "在插件数据目录写一个检查文件并返回它作为证据",
    async start(ctx, signal) {
      const ref = `proof-${ctx.idempotencyKey}.txt`, path = join(data, ref);
      // Repeated starts of this attempt return the existing file, including after a host restart.
      try { await writeFile(path, "已验证\n", { flag: "wx", signal }); }
      catch (e) { if (e.code !== "EEXIST") throw e; }
      return { ref, status: "done", summary: "已验证：检查文件已创建", evidence: [{ text: `检查文件 ${ref}` }] };
    },
  });
  api.stageGate({
    id: "word", name: "结果验收词", describe: "结果必须说明已验证",
    async review(ctx) {
      return ctx.result.summary.includes("已验证") ? { ok: true } : { ok: false, reason: "结果缺少“已验证”" };
    },
  });
}
