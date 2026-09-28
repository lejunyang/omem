import { describe, it, expect } from "vitest";
import { findLoop, pushFrame, MAX_TRAIL, type TrailFrame } from "../../../../packages/ui/src/trail";

function fr(kind: TrailFrame["kind"], id: string): TrailFrame {
  return { kind, id, title: id };
}

describe("trail loop detection", () => {
  it("returns -1 when no existing frame matches", () => {
    const stack = [fr("module", "assistant"), fr("file", "f1")];
    expect(findLoop(stack, { kind: "fragment", id: "fr1" })).toBe(-1);
  });
  it("finds an existing frame regardless of depth", () => {
    const stack = [fr("module", "assistant"), fr("file", "f1"), fr("fragment", "fr1")];
    expect(findLoop(stack, { kind: "fragment", id: "fr1" })).toBe(2);
  });
  it("does not confuse same id across kinds", () => {
    const stack = [fr("file", "f1")];
    expect(findLoop(stack, { kind: "fragment", id: "f1" })).toBe(-1);
  });
  it("pushFrame is bounded to MAX_TRAIL", () => {
    let stack: TrailFrame[] = [];
    for (let i = 0; i < MAX_TRAIL + 5; i++) stack = pushFrame(stack, fr("file", "f" + i));
    expect(stack).toHaveLength(MAX_TRAIL);
    expect(stack[0].id).toBe("f5"); // oldest dropped
  });

  it("supports a 5-level drill and detects return-to-level loop", () => {
    // 1 module -> 2 file -> 3 fragment -> 4 file -> 5 fragment
    let stack: TrailFrame[] = [];
    stack = pushFrame(stack, fr("module", "assistant"));
    stack = pushFrame(stack, fr("file", "fApp"));
    stack = pushFrame(stack, fr("fragment", "frRule"));
    stack = pushFrame(stack, fr("file", "fMem"));
    stack = pushFrame(stack, fr("fragment", "frImpl"));
    expect(stack).toHaveLength(5);
    // user navigates back to level 2 (the first file) -> loop detected
    expect(findLoop(stack, { kind: "file", id: "fApp" })).toBe(1);
    // back twice pops to level 3
    stack = stack.slice(0, 4);
    expect(stack).toHaveLength(4);
    expect(stack[3].id).toBe("fMem");
  });
});
