import { createServer, type Server, type Socket } from "node:net";
import type { App } from "./app.ts";
import { tunnelConnect } from "./peer-tunnel.ts";

/**
 * The local end of a preview (docs/v2/preview.md), run by `omem peer open <id>`: for each of the
 * preview's ports, listen on the same port number here and pipe every connection through the
 * tunnel to that port on the peer. The browser sees `localhost:<port>` just as when the dev server
 * runs locally, so whatever the project hard-codes (asset hosts, sub-app entries, HMR ports) works.
 */

export type ForwardPort = { port: number; ok: boolean; error: string | null };
type Forward = { preview: string; ports: Map<number, { servers: Server[]; state: ForwardPort }> };

export class PreviewForwards {
  private forwards = new Map<string, Forward>();
  private app: App;
  private peer: string;
  constructor(app: App, peer: string) {
    this.app = app;
    this.peer = peer;
  }

  list() {
    return [...this.forwards.values()].map((f) => ({ preview: f.preview, ports: [...f.ports.values()].map((p) => ({ ...p.state })) }));
  }

  /** Forward exactly these ports of the preview (ones no longer listed are closed). */
  async open(preview: string, ports: number[]) {
    const f = this.forwards.get(preview) ?? { preview, ports: new Map() };
    this.forwards.set(preview, f);
    for (const [port, p] of f.ports) if (!ports.includes(port)) this.closePort(f, port, p);
    for (const port of ports) {
      const had = f.ports.get(port);
      if (had?.state.ok) continue;
      // Taken by another preview's forward: that one is over (one preview per repository there too).
      for (const other of this.forwards.values()) if (other !== f && other.ports.get(port)?.state.ok) this.close(other.preview);
      f.ports.set(port, await this.listen(preview, port));
    }
    return { preview, ports: [...f.ports.values()].map((p) => ({ ...p.state })) };
  }

  close(preview: string) {
    const f = this.forwards.get(preview);
    if (!f) return false;
    for (const [port, p] of f.ports) this.closePort(f, port, p);
    this.forwards.delete(preview);
    return true;
  }

  closeAll() {
    for (const id of [...this.forwards.keys()]) this.close(id);
  }

  private closePort(f: Forward, port: number, p: { servers: Server[] }) {
    for (const s of p.servers) s.close();
    f.ports.delete(port);
  }

  private async listen(preview: string, port: number): Promise<{ servers: Server[]; state: ForwardPort }> {
    const servers: Server[] = [];
    const on = (host: string) =>
      new Promise<Server>((ok, fail) => {
        const s = createServer((sock) => this.pipe(preview, port, sock));
        s.once("error", fail).listen(port, host, () => {
          s.removeAllListeners("error");
          s.on("error", () => {});
          ok(s);
        });
      });
    try {
      servers.push(await on("127.0.0.1"));
    } catch (e) {
      const used = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
      return { servers, state: { port, ok: false, error: used ? `本机 ${port} 已被占用（可能你自己也在跑这个服务）` : (e as Error).message } };
    }
    // A browser may try ::1 first for "localhost"; best effort, IPv6 may be off.
    await on("::1").then((s) => servers.push(s), () => {});
    return { servers, state: { port, ok: true, error: null } };
  }

  private pipe(preview: string, port: number, sock: Socket) {
    // Hold what the browser sends until the far end is connected.
    sock.pause();
    sock.on("error", () => {});
    tunnelConnect(this.app, this.peer, `/api/previews/${encodeURIComponent(preview)}/tcp?port=${port}`).then(
      (up) => {
        up.pipe(sock);
        sock.pipe(up);
        sock.resume();
        const close = () => (up.destroy(), sock.destroy());
        for (const s of [up, sock]) s.on("error", close).on("close", close).on("end", close);
      },
      (e: Error & { status?: number }) => {
        sock.destroy();
        // The preview stopped (or the port went away) over there: stop listening here.
        if (e.status === 404) this.close(preview);
      },
    );
  }
}
