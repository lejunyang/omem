import { describe, expect, test } from "vitest";
import { allowSimulatorEmbedding, normalizeSimulatorUrl } from "./device-simulator";

describe("device simulator boundaries", () => {
  test("rejects executable, extension and file addresses", () => {
    for (const url of ["javascript:alert(1)", "file:///tmp/a", "chrome-extension://abc/popup.html", "about:blank"]) {
      expect(() => normalizeSimulatorUrl(url)).toThrow();
    }
    expect(normalizeSimulatorUrl("https://example.com/a?b=c#d")).toBe("https://example.com/a?b=c#d");
  });
  test("removes only framing directives and preserves scripts and cookies", () => {
    expect(allowSimulatorEmbedding([
      { name: "X-Frame-Options", value: "DENY" },
      { name: "Content-Security-Policy", value: "default-src 'self'; frame-ancestors 'none'; script-src 'nonce-abc'" },
      { name: "content-security-policy", value: "frame-ancestors https://example.com" },
      { name: "Set-Cookie", value: "a=1" }, { name: "Set-Cookie", value: "b=2" }
    ])).toEqual([
      { name: "Content-Security-Policy", value: "default-src 'self'; script-src 'nonce-abc'" },
      { name: "Set-Cookie", value: "a=1" }, { name: "Set-Cookie", value: "b=2" }
    ]);
  });
});
