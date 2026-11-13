import { describe, expect, it } from "vitest";
import { serviceEnvironment } from "../src/core/service.ts";

describe("background service desktop environment", () => {
  it("carries desktop access from the terminal and clears values left by an earlier login", () => {
    expect(serviceEnvironment({ DISPLAY: ":12", XAUTHORITY: "/tmp/example-xauth", OMEM_TOOL_AAD: "/opt/example/aad", UNRELATED_SECRET: "private" })).toEqual({
      DISPLAY: ":12", XAUTHORITY: "/tmp/example-xauth", WAYLAND_DISPLAY: "", XDG_RUNTIME_DIR: "", DBUS_SESSION_BUS_ADDRESS: "", OMEM_TOOL_AAD: "/opt/example/aad",
    });
    expect(serviceEnvironment({}).DISPLAY).toBe("");
  });
});
