import type { DatabaseSync } from "node:sqlite";
import { parseFile, type ParsedCall } from "../code/parse.js";
import { materialFromRow, type RetrievalUnit } from "./units.js";
import type { RetrievalHit } from "./port.js";

/** Reuse the whole captured file's AST. Parsing a method excerpt on its own
 * loses class syntax; consulting today's working tree breaks fixed revisions. */
export class CodeNavigation {
  private calls = new Map<string, ParsedCall[]>();
  constructor(private db: DatabaseSync) {}

  matches(
    unit: RetrievalUnit,
    symbols: string[],
  ): NonNullable<RetrievalHit["codeMatches"]> {
    const target = unit.target;
    if (unit.subtype !== "code" || target.kind !== "source") return [];
    let calls = this.calls.get(target.revisionId);
    if (!calls) {
      const row = this.db
        .prepare(
          `SELECT r.*,s.namespace,s.external_id
        FROM revisions r JOIN sources s ON s.id=r.source_id WHERE r.id=?`,
        )
        .get(target.revisionId);
      const material = row && materialFromRow(this.db, row);
      calls = material
        ? parseFile(material.path ?? material.title, material.text).calls
        : [];
      // Only an acceleration cache. Eviction never changes the snapshot read.
      if (this.calls.size >= 64)
        this.calls.delete(this.calls.keys().next().value!);
      this.calls.set(target.revisionId, calls);
    }
    return symbols.flatMap((symbol) => {
      // The existing parser resolves the terminal name, not receiver types or
      // import aliases. Preserve that uncertainty for Agent readers.
      const name = symbol.split(".").at(-1)!;
      const lines = [
        ...new Set(
          calls!
            .filter(
              (c) =>
                c.callee.toLowerCase() === name &&
                c.rangeStart.line >= target.startLine &&
                c.rangeStart.line <= target.endLine,
            )
            .map((c) => c.rangeStart.line),
        ),
      ];
      return lines.length
        ? [
            {
              symbol,
              kind: "call" as const,
              status: "candidate" as const,
              lines,
            },
          ]
        : [];
    });
  }
}
