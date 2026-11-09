import { describe, expect, it } from "vitest";
import { shouldHandleEnterKey } from "./keyboard";

describe("keyboard helpers", () => {
  it("handles Enter when input is not composing", () => {
    expect(shouldHandleEnterKey({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(true);
  });

  it("ignores Enter during IME composition", () => {
    expect(shouldHandleEnterKey({ key: "Enter", isComposing: true, keyCode: 13 })).toBe(false);
  });

  it("ignores keyCode 229 composition fallback", () => {
    expect(shouldHandleEnterKey({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(false);
  });

  it("ignores non-Enter keys", () => {
    expect(shouldHandleEnterKey({ key: ",", isComposing: false, keyCode: 188 })).toBe(false);
  });
});
