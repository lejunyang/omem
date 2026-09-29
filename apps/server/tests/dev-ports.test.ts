import { createServer } from "node:net";
import { expect, it } from "vitest";
import { selectDevPort } from "../../../scripts/dev-ports.js";

it("moves an occupied default, rejects an occupied override and invalid ports", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = (occupied.address() as { port: number }).port;
  try {
    const chosen = await selectDevPort(undefined, port, "API");
    expect(chosen).toBeGreaterThan(0);
    expect(chosen).not.toBe(port);
    await expect(selectDevPort(String(port), 4317, "API")).rejects.toThrow("已被占用");
    for (const bad of ["oops", "-1", "65536", "1.5"])
      await expect(selectDevPort(bad, 4317, "API")).rejects.toThrow("invalid port");
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
});
