import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { artifactCounts, artifactFile, deleteArtifacts, listArtifacts, workOf } from "../agents/artifacts.ts";
import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";

/**
 * Run artifacts over HTTP (docs/v2/artifacts.md). The list follows the run's permission (route
 * rules); a file is served by its key, so a test report's own files load by relative URL from a
 * sandboxed page that sends no cookie, and so does `omem peer open` without the token's help.
 */
export function registerArtifactRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  server.get("/api/runs/:id/artifacts", async (req) => {
    const id = (req.params as { id: string }).id;
    const artifacts = await listArtifacts(app, id);
    const workId = await workOf(app, id);
    // Task titles for the groups (a task-driven delegation).
    const { isTaskWork, listTasks } = await import("../agents/code-tasks.ts");
    const tasks = workId && isTaskWork(app, workId) ? Object.fromEntries(listTasks(app, workId).map((t) => [t.seq, t.title])) : {};
    return { workId, artifacts, perTask: workId ? artifactCounts(app, workId) : {}, tasks };
  });
  server.delete("/api/runs/:id/artifacts/:artifact", async (req) => {
    const { id, artifact } = req.params as { id: string; artifact: string };
    const runOwner = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id;
    if (who(req) !== OWNER && runOwner !== who(req)) throw new HttpError(404, "运行不存在");
    const workId = await workOf(app, id);
    const row = one<{ run_id: string; work_id: string | null }>(app.db, "select run_id, work_id from run_artifacts where id = ?", artifact);
    if (!row || (row.run_id !== id && (!workId || row.work_id !== workId))) throw new HttpError(404, "没有这个产物");
    return { deleted: deleteArtifacts(app, { ids: [artifact] }) };
  });
  server.get("/api/artifacts/:token/*", async (req, reply) => {
    const { token } = req.params as { token: string };
    const rest = (req.params as Record<string, string>)["*"] ?? "";
    const found = artifactFile(app, token, rest);
    if (!found) throw new HttpError(404, "没有这个产物");
    const { file, mime, size, artifact } = found;
    const page = artifact.kind === "site" || artifact.kind === "html" || /^image\/svg/.test(mime) || /^text\/html/.test(mime);
    reply
      .type(mime)
      .header("x-content-type-options", "nosniff")
      .header("accept-ranges", "bytes")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.split(/[\\/]/).pop()!)}`);
    // A page runs in its own opaque origin: its scripts reach neither omem's cookies nor its API.
    if (page) reply.header("content-security-policy", "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads");
    // …and loads its own files (modules, fetched data) across that origin.
    if (artifact.kind === "site") reply.header("access-control-allow-origin", "*");
    // Videos are seeked with Range requests.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
      reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
      return reply.send(createReadStream(file, { start, end }));
    }
    reply.header("content-length", size);
    return reply.send(createReadStream(file));
  });
}
