import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveAuth } from "../auth/http.ts";
import type { App } from "../core/app.ts";
import { getSpace, updateSpace } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { git, resolveRef } from "../core/git.ts";
import { codeIndexConfig, type CodeIndexConfig } from "./code-baseline.ts";
import { checkHookToken, codeIndexView, createHookToken, hookTokenInfo, notifyCodeChange, refreshRepoSpaces, revokeHookToken } from "./code-index.ts";

/**
 * Routes for repository code indexes (docs/v2/code-index.md): a space's baseline and followed
 * branches, “立即同步”, and the change notification another system calls when a repository got a
 * push (its own token: it can trigger a fetch and nothing else). What each needs is in src/auth/routes.ts.
 */
export function registerCodeIndexRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
    const r = schema.safeParse(value ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const refName = z.string().trim().max(200).regex(/^[^\s~^:?*[\\]*$/, "不是合法的分支、标签或提交名");

  server.get("/api/spaces/:id/code-index", async (req) => codeIndexView(app, (req.params as { id: string }).id));

  server.put("/api/spaces/:id/code-index", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有 omem 的主人能改代码索引的方式");
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ mode: z.enum(["baseline", "directory"]).optional(), ref: refName.optional(), branches: z.array(refName.min(1)).max(20).optional() }), req.body);
    const s = getSpace(app, id);
    if (!s.rootPath || !git(s.rootPath, ["rev-parse", "--git-dir"]).ok) throw new HttpError(400, `空间 ${id} 没有关联 Git 仓库`);
    if (b.ref && !resolveRef(s.rootPath, b.ref)) throw new HttpError(400, `仓库里没有 ${b.ref}（远端新建的分支先“立即同步”拉取一次）`);
    const before = codeIndexConfig(s);
    const next: CodeIndexConfig = { ...before, ...(b.mode ? { mode: b.mode } : {}), ...(b.ref !== undefined ? { ref: b.ref } : {}), ...(b.branches ? { branches: [...new Set(b.branches)] } : {}) };
    updateSpace(app, id, { settings: { ...getSpace(app, id).settings, codeIndex: next } });
    // A different baseline (or a switch between baseline and directory) is read now; followed branches on the next refresh.
    const moved = (next.mode ?? null) !== (before.mode ?? null) || (next.ref ?? "") !== (before.ref ?? "");
    const added = (next.branches ?? []).some((x) => !(before.branches ?? []).includes(x));
    if (moved || added) void refreshRepoSpaces(app, { spaces: [id], force: moved }).catch((e) => console.warn(`[omem] 同步 ${id} 失败：${(e as Error).message}`));
    return codeIndexView(app, id);
  });

  // “立即同步”: fetch now (waited for, so the page can say what happened), then read what moved.
  server.post("/api/spaces/:id/code-index/refresh", async (req) => {
    const id = (req.params as { id: string }).id;
    getSpace(app, id);
    const r = await refreshRepoSpaces(app, { spaces: [id], force: true });
    return { ...codeIndexView(app, id), report: r.spaces[0] ?? null };
  });

  // The token another system uses for change notifications: made, shown once, revoked by the owner.
  server.get("/api/code-index/hook", async () => ({ token: hookTokenInfo(app) }));
  server.post("/api/code-index/hook", async () => ({ token: createHookToken(app) }));
  server.delete("/api/code-index/hook", async () => {
    revokeHookToken(app);
    return { ok: true };
  });

  /**
   * A repository got a push: fetch it and refresh its spaces. Called by another system with the hook
   * token (Authorization: Bearer, X-Omem-Token, or ?token= for systems that can only set a URL), or
   * by the owner. Only triggers: no code travels with it.
   */
  server.post("/api/code-index/notify", async (req, reply) => {
    const header = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    const token = header || String(req.headers["x-omem-token"] ?? "") || String((req.query as { token?: string })?.token ?? "");
    const owner = () => {
      const a = resolveAuth(app, req);
      return a?.userId === OWNER && !a.restricted;
    };
    if (!(token && checkHookToken(app, token)) && !owner()) return reply.status(401).send({ error: token ? "令牌无效（在 设置 → 空间 的代码索引里重新生成）" : "需要令牌：Authorization: Bearer <令牌>" });
    const fields = z.object({ repo: z.string().max(500).optional(), space: z.string().max(100).optional(), branch: z.string().max(200).optional(), ref: z.string().max(250).optional() });
    const b = { ...parse(fields, req.query ?? {}), ...parse(fields, typeof req.body === "object" ? req.body : {}) };
    const branch = b.branch ?? (b.ref?.startsWith("refs/heads/") ? b.ref.slice(11) : undefined);
    const r = notifyCodeChange(app, { repo: b.repo, space: b.space, branch });
    return reply.status(r.queued ? 202 : 200).send(r.queued ? r : { ...r, note: "没有对应的仓库空间（仓库地址按 git remote 比对，或直接给 space）" });
  });
}
