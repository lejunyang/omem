import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { createUser } from "../src/core/users.ts";
import { forgetPluginToolCapabilities, memberToolAccess, setPluginToolCapabilities, toolCapability } from "../src/auth/tools.ts";
import { testApp } from "./helpers.ts";

let app: App;
beforeEach(() => {
  app = testApp();
  createUser(app, { id: "ann", name: "成员 A" });
  createUser(app, { id: "ole", name: "观察者 O", role: "observer" });
  setPluginToolCapabilities([{ name: "demo_read", write: false }, { name: "demo_save", write: true }]);
});
afterEach(() => {
  forgetPluginToolCapabilities(["demo_read", "demo_save"]);
  app.db.close();
  rmSync(app.home, { recursive: true, force: true });
});

const denied = (r: object) => "deniedCapability" in r;

it("插件的只读工具给能用助手的人；会写入的只在他能改原件的空间里；卸载后回到仅限本人", () => {
  expect(toolCapability("demo_read")).toBe("ask.send");
  expect(toolCapability("demo_save")).toBe("sources.edit");

  const ann = memberToolAccess(app, "ann");
  expect(denied(ann("demo_read"))).toBe(false);
  const save = ann("demo_save");
  expect(denied(save)).toBe(false);
  expect((save as { writable?: string[] }).writable).toContain("personal-ann");

  // A run limited to a space the member cannot edit: the write tool is not offered there.
  expect(denied(memberToolAccess(app, "ann", { spaces: ["personal-ole"] })("demo_save"))).toBe(true);

  const observer = memberToolAccess(app, "ole");
  expect(denied(observer("demo_read"))).toBe(false);
  expect(denied(observer("demo_save"))).toBe(true);

  forgetPluginToolCapabilities(["demo_read", "demo_save"]);
  expect(toolCapability("demo_read")).toBe("owner");
  expect(denied(memberToolAccess(app, "ann")("demo_read"))).toBe(true);
});
