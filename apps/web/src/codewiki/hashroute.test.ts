import { describe, it, expect } from "vitest";
import { parseHash, writeHash } from "../../../../packages/ui/src/OmHashRoute";

describe("hash route round-trip", () => {
  it("defaults to overview", () => {
    const r = parseHash("");
    expect(r.view.name).toBe("overview");
  });
  it("parses module", () => {
    const r = parseHash("#/module/assistant");
    expect(r.view.name).toBe("module");
    expect((r.view as { module: string }).module).toBe("assistant");
  });
  it("parses file + line", () => {
    const r = parseHash("#/file/file_abc?line=42");
    expect(r.view.name).toBe("file");
    expect((r.view as { fileId: string }).fileId).toBe("file_abc");
    expect((r.view as { line?: number }).line).toBe(42);
  });
  it("parses trail segments", () => {
    const r = parseHash("#/graph/trail/module/assistant/file/f_123/fragment/fr_9");
    expect(r.trail).toHaveLength(3);
    expect(r.trail[0]).toMatchObject({ kind: "module", id: "assistant" });
    expect(r.trail[2]).toMatchObject({ kind: "fragment", id: "fr_9" });
  });
  it("write then parse is stable", () => {
    const out = writeHash({
      view: { name: "file", fileId: "file_xyz", line: 7 },
      trail: [{ kind: "module", id: "memory", title: "memory" }, { kind: "fragment", id: "fr_1", title: "t" }],
    });
    expect(out).toContain("#/file/file_xyz?line=7/trail/module/memory/fragment/fr_1");
    const back = parseHash(out);
    expect(back.view.name).toBe("file");
    expect(back.trail).toHaveLength(2);
  });
  it("falls back on corrupt hash", () => {
    expect(parseHash("#/totally/bogus").view.name).toBe("overview");
  });
  it("round-trips a 5-level drill trail", () => {
    const route = {
      view: { name: "graph" as const },
      trail: [
        { kind: "module" as const, id: "assistant", title: "assistant" },
        { kind: "file" as const, id: "fApp", title: "app.ts" },
        { kind: "fragment" as const, id: "frRule", title: "rule" },
        { kind: "file" as const, id: "fMem", title: "memory.ts" },
        { kind: "fragment" as const, id: "frImpl", title: "impl" },
      ],
    };
    const out = writeHash(route);
    expect(out).toContain("/trail/module/assistant/file/fApp/fragment/frRule/file/fMem/fragment/frImpl");
    const back = parseHash(out);
    expect(back.trail.map((f) => f.kind + ":" + f.id)).toEqual(["module:assistant","file:fApp","fragment:frRule","file:fMem","fragment:frImpl"]);
  });
});
