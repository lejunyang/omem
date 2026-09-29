import { createServer } from "node:net";

/** Defaults may move; explicit ports fail loudly. The chosen port is passed to
 * both the backend and proxy, so the browser never connects to another API. */
export async function selectDevPort(value: string | undefined, fallback: number, label: string): Promise<number> {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`${label}: invalid port ${value}`);
  try {
    return await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const assigned = (server.address() as { port: number }).port;
        server.close(() => resolve(assigned));
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (value !== undefined) throw new Error(`端口 ${port}（${label}）已被占用；请设置其他端口`);
    const assigned = await selectDevPort("0", fallback, label);
    console.log(`${label}: 默认端口 ${port} 已占用，使用 ${assigned}`);
    return assigned;
  }
}
