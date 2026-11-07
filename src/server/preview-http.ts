import type { IncomingMessage, Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPreview, listPreviews, previewDial, previewTargets, startPreview, stopAllPreviews, stopLeftovers, stopPreview } from "../agents/previews.ts";
import type { App } from "../core/app.ts";
import { PREVIEW_TCP, splice } from "../core/peer-tunnel.ts";
import { OWNER, userForToken } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { bearerToken } from "../auth/http.ts";
import { trustedLocal } from "./origin.ts";

/**
 * Previews over HTTP (docs/v2/preview.md): starting, watching and stopping them, and the raw
 * stream to one of a preview's ports that `omem peer open` pipes a browser connection into.
 * Owner only, like web VS Code: the command is the owner's and the server shows the workspace.
 */
export function registerPreviewRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  stopLeftovers(app);
  server.addHook("onClose", async () => stopAllPreviews(app));
  const owner = (req: FastifyRequest) => {
    if (who(req) !== OWNER) throw new HttpError(403, "预览只对本人开放");
  };
  const q = <T>(schema: z.ZodType<T>, v: unknown): T => {
    const r = schema.safeParse(v ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  // `local`: the page is on this machine, so the ports are too (no forwarding needed).
  const isLocal = (req: FastifyRequest) => !bearerToken(req) && /^(127\.|::1$|::ffff:127\.)/.test(req.ip ?? "");

  server.get("/api/runs/:id/previews", async (req) => {
    owner(req);
    const id = (req.params as { id: string }).id;
    return { local: isLocal(req), targets: previewTargets(app, id), previews: listPreviews(app, id) };
  });
  server.get("/api/previews", async (req) => {
    owner(req);
    return { local: isLocal(req), previews: listPreviews(app) };
  });
  server.post("/api/previews", async (req) => {
    owner(req);
    const b = q(z.object({ run: z.string().min(1), space: z.string().min(1), name: z.string().optional() }), req.body);
    return startPreview(app, b);
  });
  server.get("/api/previews/:id", async (req) => {
    owner(req);
    return getPreview((req.params as { id: string }).id);
  });
  server.delete("/api/previews/:id", async (req) => {
    owner(req);
    return stopPreview(app, (req.params as { id: string }).id);
  });
  // Answered here only when the page is not behind `omem peer open`, which handles this path itself.
  server.get("/api/local/forwards", async () => ({ forwarder: false }));
}

function ownerOf(app: App, req: IncomingMessage) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return userForToken(app, h.slice(7)) === OWNER;
  return !app.config.token && trustedLocal(req, req.socket.remoteAddress ?? "", { refuseProxied: app.config.auth.enabled });
}

/** `/api/previews/<id>/tcp?port=<n>` with `Upgrade: omem-tcp`: 101, then the port's bytes both ways. */
export function attachPreviewUpgrade(app: App, server: Server) {
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? "";
    if (!PREVIEW_TCP.test(url)) return;
    if (!ownerOf(app, req)) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    const id = decodeURIComponent(/^\/api\/previews\/([^/?]+)/.exec(url)![1]);
    const port = Number(new URL(url, "http://x").searchParams.get("port"));
    const dial = previewDial(id, port);
    if (!dial) return void socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.on("error", () => {});
    const attempt = (i: number) => {
      const up = connect(port, dial.hosts[i]);
      up.once("connect", () => {
        up.removeAllListeners("error");
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: omem-tcp\r\n\r\n");
        if (head.length) up.write(head);
        dial.opened();
        // A dev server that closes after a response (`Connection: close`) must not cut it short.
        splice(up, socket);
      });
      // Bound to one family only (a dev server on "localhost" may listen on ::1 alone): try the next.
      up.once("error", () => (i + 1 < dial.hosts.length ? attempt(i + 1) : socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")));
    };
    attempt(0);
  });
}
