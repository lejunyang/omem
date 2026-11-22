import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { acceptCredentialDeclarations, setTrust, setTrustPermanent, trustPermanent, trustState } from "../src/plugins/trust.ts";
import { testApp } from "./helpers.ts";

let app: App, dir: string;
beforeEach(() => {
  app = testApp();
  dir = mkdtempSync(join(tmpdir(), "omem-trust-"));
  writeFileSync(join(dir, "server.mjs"), "export default () => {};\n");
});
afterEach(() => {
  app.db.close();
  rmSync(app.home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

it("永久信任：代码和凭据声明改了也照常信任，再次信任不丢；关掉后回到按代码确认", () => {
  setTrust(app, "demo", dir, "inprocess");
  expect(trustState(app, "demo", dir)).toBe("trusted");
  writeFileSync(join(dir, "server.mjs"), "export default () => 1;\n");
  expect(trustState(app, "demo", dir)).toBe("changed");

  setTrustPermanent(app, "demo", true);
  expect(trustPermanent(app, "demo")).toBe(true);
  expect(trustState(app, "demo", dir)).toBe("trusted");
  expect(acceptCredentialDeclarations(app, "demo", [{ id: "a" }])).toBe(true);
  expect(acceptCredentialDeclarations(app, "demo", [{ id: "b" }])).toBe(true);
  // Trusting again (say, to switch how it runs) keeps the choice.
  setTrust(app, "demo", dir, "isolated");
  expect(trustPermanent(app, "demo")).toBe(true);

  setTrustPermanent(app, "demo", false);
  writeFileSync(join(dir, "server.mjs"), "export default () => 2;\n");
  expect(trustState(app, "demo", dir)).toBe("changed");
  // Trusting again recorded no declarations: the next ones are taken, a change after that is not.
  expect(acceptCredentialDeclarations(app, "demo", [{ id: "c" }])).toBe(true);
  expect(acceptCredentialDeclarations(app, "demo", [{ id: "d" }])).toBe(false);
});

it("永久信任的链接插件只认信任时的目录", () => {
  const other = join(dir, "copy");
  mkdirSync(other);
  writeFileSync(join(other, "server.mjs"), "export default () => {};\n");
  setTrust(app, "linked", dir, "inprocess", true, undefined, false, [], undefined, true, true);
  writeFileSync(join(dir, "server.mjs"), "export default () => 3;\n");
  expect(trustState(app, "linked", dir, true, undefined, false, [], undefined, true)).toBe("trusted");
  expect(trustState(app, "linked", other, true, undefined, false, [], undefined, true)).toBe("changed");
});
