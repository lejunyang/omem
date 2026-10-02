/** Replaceable retrieval units, separate from immutable storage and reader pages. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { marked } from "marked";
import type {
  KnowledgeArtifact,
  KnowledgeMaterial,
} from "../../../../packages/contracts/src/knowledge.js";
import { parseFile } from "../code/parse.js";
import { fragmentPositions } from "../knowledge/structure.js";
import { stableDigest } from "../storage/digest.js";
import type { ProvenanceRef, RetrievalHit, SourceAnchor } from "./port.js";

export const UNIT_VERSION = "structure-icu-v2";
type Row = Record<string, unknown>;
export type RetrievalUnit = Omit<RetrievalHit, "score" | "routes"> & {
  owner: string;
  visibilityIds: string[];
  topicPath: string[];
  subtype: string;
};
export type Passage = {
  text: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
};

/** Parse block boundaries once. Code fences, tables and lists remain coherent. */
export function markdownPassages(text: string): Passage[] {
  let cursor = 0;
  const headings: { depth: number; title: string }[] = [],
    output: Passage[] = [];
  for (const token of marked.lexer(text)) {
    const offset = text.indexOf(token.raw, cursor);
    if (offset < 0) continue;
    cursor = offset + token.raw.length;
    if (token.type === "heading") {
      while (headings.at(-1) && headings.at(-1)!.depth >= token.depth)
        headings.pop();
      headings.push({ depth: token.depth, title: token.text });
    } else if (token.type !== "space" && token.raw.trim()) {
      output.push({
        text: token.raw.trim(),
        startLine: text.slice(0, offset).split("\n").length,
        endLine: text
          .slice(0, cursor - token.raw.match(/\s*$/)![0].length)
          .split("\n").length,
        headingPath: headings.map((h) => h.title),
      });
    }
  }
  // Heading-only documents are still findable; their actual bytes are the result.
  return output.length
    ? output
    : text.trim()
      ? [
          {
            text,
            startLine: 1,
            endLine: text.split("\n").length,
            headingPath: headings.map((h) => h.title),
          },
        ]
      : [];
}

export function codePassages(material: KnowledgeMaterial): Passage[] {
  const parsed = parseFile(material.path ?? material.title, material.text);
  const symbols = parsed.symbols.filter(
    (s) =>
      !parsed.symbols.some(
        (child) =>
          child !== s &&
          child.rangeStart.line >= s.rangeStart.line &&
          child.rangeEnd.line <= s.rangeEnd.line &&
          (child.rangeStart.line > s.rangeStart.line ||
            child.rangeEnd.line < s.rangeEnd.line),
      ),
  );
  if (!symbols.length)
    return [
      {
        text: material.text,
        startLine: 1,
        endLine: material.lineCount,
        headingPath: [],
      },
    ];
  const lines = material.text.split("\n");
  const output: Passage[] = symbols.map((s) => {
    let start = s.rangeStart.line;
    // Adjacent comments belong with the declaration, without inventing intent.
    while (start > 1 && /^\s*(?:\/\*|\*|\/\/)/.test(lines[start - 2]!)) start--;
    const parents = parsed.symbols
      .filter(
        (p) =>
          p !== s &&
          p.rangeStart.line <= s.rangeStart.line &&
          p.rangeEnd.line >= s.rangeEnd.line,
      )
      .sort((a, b) => a.rangeStart.line - b.rangeStart.line);
    return {
      text: lines.slice(start - 1, s.rangeEnd.line).join("\n"),
      startLine: start,
      endLine: s.rangeEnd.line,
      headingPath: [...parents.map((p) => p.qualifiedName), s.qualifiedName],
    };
  });
  // Imports, top-level setup and configuration are real searchable content too.
  const occupied = output.flatMap((p) =>
    Array.from(
      { length: p.endLine - p.startLine + 1 },
      (_, i) => p.startLine + i,
    ),
  );
  const covered = new Set(occupied);
  let start = 1;
  for (let line = 1; line <= lines.length + 1; line++) {
    if (line <= lines.length && !covered.has(line)) continue;
    if (start < line) {
      const text = lines.slice(start - 1, line - 1).join("\n");
      if (text.trim())
        output.push({
          text,
          startLine: start,
          endLine: line - 1,
          headingPath: ["模块定义与初始化"],
        });
    }
    start = line + 1;
  }
  return output.sort((a, b) => a.startLine - b.startLine);
}

const idFor = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tableExists = (db: DatabaseSync, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((s): s is string => typeof s === "string")
    : [];

export function materialFromRow(
  db: DatabaseSync,
  row: Row,
): KnowledgeMaterial | null {
  const body = JSON.parse(String(row.body));
  if (body.context?.derived || body.provenance?.producerKind === "derived")
    return null;
  const parts = body.parts as (KnowledgeMaterial["images"][number] & {
    type: string;
    text?: string;
    url?: string;
  })[];
  const text = parts
    .filter((p) => p.type === "text" || p.type === "link")
    .map((p) =>
      p.type === "text" ? (p.text ?? "") : `${p.label ?? ""}\n${p.url}`,
    )
    .join(body.context?.captureFormat === "verbatim-v1" ? "" : "\n\n");
  const images = parts
    .filter((p) => p.type === "image")
    .map((p) => ({
      assetId: p.assetId,
      mimeType: p.mimeType,
      label: p.label ?? String(row.title),
    }));
  const alias = tableExists(db, "knowledge_material_aliases")
    ? db
        .prepare(
          "SELECT material_key FROM knowledge_material_aliases WHERE source_id=?",
        )
        .get(String(row.source_id))
    : undefined;
  return {
    key: String(alias?.material_key ?? `${row.namespace}:${row.external_id}`),
    title: String(row.title),
    path:
      typeof body.context?.filePath === "string" ? body.context.filePath : null,
    sourceId: String(row.source_id),
    revisionId: String(row.id),
    namespace: String(row.namespace),
    digest: stableDigest({
      text,
      images,
      actor: body.provenance?.actorId ?? null,
      quoted: body.provenance?.quoted ?? false,
      forwarded: body.provenance?.forwarded ?? false,
    }),
    conversationId: body.context?.conversationId,
    actorId: body.provenance?.actorId,
    eventAt: body.provenance?.eventAt,
    text,
    images,
    lineCount: text.split("\n").length,
    fragments: db
      .prepare(
        "SELECT id,text FROM fragments WHERE revision_id=? ORDER BY ordinal",
      )
      .all(String(row.id)) as { id: string; text: string }[],
  };
}

export function sourceAnchor(
  material: KnowledgeMaterial,
  startLine: number,
  endLine: number,
): SourceAnchor {
  return {
    kind: "source",
    key: material.key,
    revisionId: material.revisionId,
    digest: material.digest,
    startLine,
    endLine,
    fragmentIds:
      !material.text.trim() && material.images.length
        ? material.fragments.map((f) => f.id)
        : fragmentPositions(material)
            .filter((f) => f.startLine <= endLine && f.endLine >= startLine)
            .map((f) => f.id),
  };
}

function sourceUnits(material: KnowledgeMaterial, row: Row): RetrievalUnit[] {
  const body = JSON.parse(String(row.body)),
    code = /\.(?:[cm]?[jt]sx?|vue)$/i.test(material.path ?? material.title);
  const passages = code
    ? codePassages(material)
    : material.text.trim()
      ? markdownPassages(material.text)
      : material.images.length
        ? [
            {
              text: material.images.map((i) => i.label).join("\n"),
              startLine: 1,
              endLine: 1,
              headingPath: ["图片材料"],
            },
          ]
        : [];
  const metadata = [
    material.conversationId && `会话：${material.conversationId}`,
    material.actorId && `发言人：${material.actorId}`,
    material.eventAt && `事件时间：${material.eventAt}`,
    body.context?.replyTo && `回复：${body.context.replyTo}`,
  ]
    .filter(Boolean)
    .join("；");
  let offset = 0;
  const partContext = (
    body.parts as {
      type: string;
      text?: string;
      url?: string;
      label?: string;
      provenance?: {
        actorExternalId?: string;
        actorPrincipalId?: string;
        observedAt?: string;
        replyTo?: string;
        quoted?: boolean;
      };
    }[]
  )
    .filter((p) => p.type === "text" || p.type === "link")
    .map((p, index) => {
      if (index)
        offset += body.context?.captureFormat === "verbatim-v1" ? 0 : 2;
      const startLine = material.text.slice(0, offset).split("\n").length;
      offset += (
        p.type === "text" ? (p.text ?? "") : `${p.label ?? ""}\n${p.url}`
      ).length;
      return {
        startLine,
        endLine: material.text.slice(0, offset).split("\n").length,
        provenance: p.provenance,
      };
    });
  return passages.flatMap((p, index) => {
    const target = sourceAnchor(material, p.startLine, p.endLine);
    if (!target.fragmentIds.length) return [];
    const parts = partContext.filter(
      (part) => part.startLine <= p.endLine && part.endLine >= p.startLine,
    );
    const actors = [
      ...new Set(
        parts
          .map(
            (part) =>
              part.provenance?.actorPrincipalId ??
              part.provenance?.actorExternalId,
          )
          .filter(Boolean),
      ),
    ];
    const events = [
      ...new Set(
        parts.map((part) => part.provenance?.observedAt).filter(Boolean),
      ),
    ];
    const replyContext = parts
      .map((part) => part.provenance)
      .filter(Boolean)
      .map((provenance) =>
        [
          (provenance!.actorPrincipalId ?? provenance!.actorExternalId) &&
            `发言人：${provenance!.actorPrincipalId ?? provenance!.actorExternalId}`,
          provenance!.observedAt && `事件时间：${provenance!.observedAt}`,
          provenance!.replyTo && `回复消息：${provenance!.replyTo}`,
          provenance!.quoted && "含引用内容",
        ]
          .filter(Boolean)
          .join("；"),
      )
      .filter(Boolean)
      .join("\n");
    return [
      {
        id: idFor([UNIT_VERSION, "source", material.revisionId, index]),
        owner: "source:" + material.sourceId,
        kind: "source" as const,
        title: material.title,
        text: p.text,
        context: [
          material.title,
          ...p.headingPath,
          replyContext
            ? [
                material.conversationId && `会话：${material.conversationId}`,
                replyContext,
              ]
                .filter(Boolean)
                .join("\n")
            : metadata,
        ]
          .filter(Boolean)
          .join("\n"),
        headingPath: p.headingPath,
        target,
        references: [target],
        visibilityIds: target.fragmentIds,
        topicPath: list(body.context?.topicPath),
        subtype: code
          ? "code"
          : material.conversationId
            ? "conversation"
            : "document",
        eventAt:
          events.length === 1
            ? events[0]!
            : events.length > 1
              ? null
              : (material.eventAt ?? null),
        provenance: {
          source: material.namespace,
          actor:
            actors.length === 1
              ? actors[0]!
              : actors.length > 1
                ? null
                : (material.actorId ?? null),
          time: String(row.created_at),
        },
      },
    ];
  });
}

/** Incremental owner projections; old versions remain in their original tables. */
export class RetrievalProjection {
  private materialCache = new Map<string, KnowledgeMaterial | null>();
  private signature = "";
  private work: Promise<void> | null = null;
  constructor(readonly db: DatabaseSync) {}
  get preparing() {
    return !!this.work;
  }
  async settle() {
    await this.work;
  }

  sync() {
    if (this.work) return;
    for (const _ of this.changes()) {
      /* Native snapshot preparation is synchronous. */
    }
  }
  syncAsync(): Promise<void> {
    if (this.work) return this.work;
    this.work = (async () => {
      for (const _ of this.changes())
        await new Promise<void>((resolve) => setImmediate(resolve));
    })().finally(() => (this.work = null));
    return this.work;
  }
  private *changes() {
    const signature = idFor([
      this.db.prepare("SELECT id,head FROM sources ORDER BY id").all(),
      tableExists(this.db, "knowledge_heads")
        ? this.db
            .prepare("SELECT * FROM knowledge_heads ORDER BY document_key")
            .all()
        : [],
      this.db.prepare("SELECT id,version,status FROM tasks ORDER BY id").all(),
      this.db
        .prepare("SELECT id,head_revision_id,status FROM memories ORDER BY id")
        .all(),
      tableExists(this.db, "knowledge_material_aliases")
        ? this.db
            .prepare(
              "SELECT * FROM knowledge_material_aliases ORDER BY material_key",
            )
            .all()
        : [],
    ]);
    if (signature === this.signature) return;
    const heads = new Map(
      this.db
        .prepare("SELECT owner,identity FROM retrieval_projection_heads")
        .all()
        .map((r) => [String(r.owner), String(r.identity)]),
    );
    const wanted = new Set<string>();
    const sourceRows = this.db
      .prepare(
        "SELECT r.*,s.namespace,s.external_id FROM sources s JOIN revisions r ON r.id=s.head",
      )
      .all() as Row[];
    const materials = new Map<string, KnowledgeMaterial>();
    const sourceById = new Map(
      sourceRows.map((row) => [String(row.source_id), row]),
    );
    const material = (row: Row) => {
      const id = String(row.id);
      if (!this.materialCache.has(id))
        this.materialCache.set(id, materialFromRow(this.db, row));
      const m = this.materialCache.get(id)!;
      if (m) materials.set(m.key, m);
      return m;
    };
    for (const row of sourceRows) {
      const m = material(row);
      if (!m) continue;
      const owner = "source:" + m.sourceId,
        identity = UNIT_VERSION + ":" + m.revisionId;
      wanted.add(owner);
      if (heads.get(owner) !== identity)
        this.replace(owner, identity, sourceUnits(m, row));
      yield;
    }
    const articleRows = tableExists(this.db, "knowledge_heads")
      ? (this.db
          .prepare(
            "SELECT r.*,h.current FROM knowledge_heads h JOIN knowledge_revisions r ON r.id=h.revision_id WHERE h.current=1",
          )
          .all() as Row[])
      : [];
    const articles = new Map(
      articleRows.map((row) => [
        String(row.document_key),
        {
          revision: String(row.id),
          artifact: JSON.parse(String(row.artifact)) as KnowledgeArtifact,
        },
      ]),
    );
    const valid = (a: KnowledgeArtifact) =>
      a.dependencies.every((d) =>
        d.kind === "material"
          ? materials.get(d.key)?.digest === d.digest
          : articles.get(d.key)?.revision === d.digest,
      );
    const validArticles = new Map(
      [...articles].filter(([, a]) => valid(a.artifact)),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const [key, a] of validArticles)
        if (
          a.artifact.dependencies.some(
            (d) => d.kind === "article" && !validArticles.has(d.key),
          )
        ) {
          validArticles.delete(key);
          changed = true;
        }
    }
    const articleVisibility = (
      a: KnowledgeArtifact,
      seen = new Set<string>(),
    ): string[] =>
      a.dependencies.flatMap((d) => {
        if (d.kind === "material")
          return materials.get(d.key)?.fragments.map((f) => f.id) ?? [];
        if (seen.has(d.key)) return [];
        seen.add(d.key);
        const child = validArticles.get(d.key);
        return child ? articleVisibility(child.artifact, seen) : [];
      });
    const references = (
      a: KnowledgeArtifact,
      body: string,
      seen = new Set<string>(),
    ): SourceAnchor[] => {
      const output: SourceAnchor[] = [];
      for (const match of body.matchAll(/\[\[([\w-]+)\]\]/g)) {
        const c = a.document.citations.find((c) => c.key === match[1]);
        if (!c) continue;
        if (c.target.kind === "material") {
          const m = materials.get(c.target.key);
          if (m && c.target.startLine && c.target.endLine)
            output.push(sourceAnchor(m, c.target.startLine, c.target.endLine));
        } else {
          const key = c.target.key + ":" + (c.target.section ?? "");
          if (seen.has(key)) continue;
          seen.add(key);
          const child = validArticles.get(c.target.key);
          if (child)
            for (const s of child.artifact.document.sections.filter(
              (s) => !c.target.section || s.key === c.target.section,
            ))
              output.push(...references(child.artifact, s.body, seen));
        }
      }
      return [...new Map(output.map((r) => [idFor(r), r])).values()];
    };
    for (const [key, { revision, artifact: a }] of validArticles) {
      const owner = "knowledge:" + key,
        identity = UNIT_VERSION + ":" + revision;
      wanted.add(owner);
      if (heads.get(owner) === identity) continue;
      // The whole source background must be visible before derived prose is disclosed.
      const visibilityIds = [...new Set(articleVisibility(a))];
      const units = a.document.sections.flatMap((section) =>
        markdownPassages(section.body).map(
          (p, index): RetrievalUnit => ({
            id: idFor([
              UNIT_VERSION,
              "knowledge",
              revision,
              section.key,
              index,
            ]),
            owner,
            kind: "knowledge",
            title: a.document.title,
            text: p.text,
            context: [a.document.title, section.title, ...p.headingPath].join(
              "\n",
            ),
            headingPath: [section.title, ...p.headingPath],
            target: { kind: "knowledge", key, revision, section: section.key },
            references: references(a, p.text),
            visibilityIds,
            topicPath: a.document.topicPath ?? [],
            subtype: a.reading?.kind ?? "explanation",
            eventAt: null,
            provenance: {
              source: "knowledge",
              actor: null,
              time: a.generation.at,
            },
          }),
        ),
      );
      this.replace(owner, identity, units);
      yield;
    }
    for (const row of this.db.prepare("SELECT * FROM tasks").all()) {
      const owner = "task:" + row.id,
        identity =
          UNIT_VERSION + ":evidence-range-v1:" + row.version + ":" + row.status;
      wanted.add(owner);
      if (heads.get(owner) === identity) continue;
      const fragment = row.evidence_id
        ? this.db
            .prepare("SELECT revision_id FROM fragments WHERE id=?")
            .get(String(row.evidence_id))
        : null;
      const sourceRow = fragment
        ? this.db
            .prepare(
              "SELECT r.*,s.namespace,s.external_id FROM revisions r JOIN sources s ON s.id=r.source_id WHERE r.id=?",
            )
            .get(String(fragment.revision_id))
        : undefined;
      const m = sourceRow ? material(sourceRow) : null;
      const evidence =
        m && fragmentPositions(m).find((f) => f.id === String(row.evidence_id));
      const refs =
        m && evidence
          ? [sourceAnchor(m, evidence.startLine, evidence.endLine)]
          : [];
      const followUp = row.follow_up ? JSON.parse(String(row.follow_up)) : null;
      const text = [
        String(row.detail),
        row.next_step && `下一步：${row.next_step}`,
        row.due_at && `到期：${row.due_at}`,
        followUp && `跟进：${JSON.stringify(followUp)}`,
      ]
        .filter(Boolean)
        .join("\n");
      this.replace(owner, identity, [
        {
          id: idFor([owner, identity]),
          owner,
          kind: "task",
          title: String(row.title),
          text,
          context: `事项状态：${row.status === "waiting" ? "等待回应" : row.status === "done" ? "已完成" : row.status === "cancelled" ? "已取消" : "进行中"}`,
          headingPath: [],
          target: {
            kind: "task",
            id: String(row.id),
            version: Number(row.version),
          },
          references: refs,
          visibilityIds: row.evidence_id ? [String(row.evidence_id)] : [],
          topicPath: [],
          subtype: String(row.status),
          eventAt: String(
            this.db
              .prepare(
                "SELECT created_at FROM task_revisions WHERE task_id=? AND version=?",
              )
              .get(String(row.id), Number(row.version))?.created_at ??
              row.created_at,
          ),
          provenance: {
            source: "task",
            actor: row.owner_id ? String(row.owner_id) : null,
            time: String(row.created_at),
          },
        },
      ]);
    }
    for (const row of this.db
      .prepare(
        `SELECT m.*,r.id revision_id,r.body,r.evidence_set,r.valid_from FROM memories m
      JOIN memory_revisions r ON r.id=m.head_revision_id WHERE m.status='active'`,
      )
      .all()) {
      const owner = "memory:" + row.id,
        identity = UNIT_VERSION + ":" + row.revision_id;
      wanted.add(owner);
      if (heads.get(owner) === identity) continue;
      const body = JSON.parse(String(row.body)),
        evidence = JSON.parse(String(row.evidence_set)) as {
          fragment_id?: string;
          sourceRevisionId?: string;
        }[];
      const readable = (value: unknown): string =>
        typeof value === "string"
          ? value
          : Array.isArray(value)
            ? value.map(readable).join("\n")
            : value && typeof value === "object"
              ? Object.values(value).map(readable).filter(Boolean).join("\n")
              : "";
      const text = readable(body),
        ids = [
          ...new Set(
            evidence.flatMap((e) =>
              e.fragment_id
                ? [e.fragment_id]
                : e.sourceRevisionId
                  ? this.db
                      .prepare("SELECT id FROM fragments WHERE revision_id=?")
                      .all(e.sourceRevisionId)
                      .map((r) => String(r.id))
                  : [],
            ),
          ),
        ];
      const refs = ids.flatMap((id) => {
        const f = this.db
          .prepare("SELECT revision_id FROM fragments WHERE id=?")
          .get(id);
        const sourceRow = f
          ? this.db
              .prepare(
                "SELECT r.*,s.namespace,s.external_id FROM revisions r JOIN sources s ON s.id=r.source_id WHERE r.id=?",
              )
              .get(String(f.revision_id))
          : undefined;
        const m = sourceRow ? material(sourceRow) : null;
        const position = m && fragmentPositions(m).find((f) => f.id === id);
        return m && position
          ? [sourceAnchor(m, position.startLine, position.endLine)]
          : [];
      });
      this.replace(owner, identity, [
        {
          id: idFor([owner, identity]),
          owner,
          kind: "memory",
          title: String(
            body.title ?? body.statement ?? body.summary ?? text.split("\n")[0],
          ).slice(0, 200),
          text,
          context: `已应用记忆：${row.kind === "episode" ? "经历" : row.kind === "procedure" ? "方法" : "事实"}`,
          headingPath: [],
          target: {
            kind: "memory",
            id: String(row.id),
            version: Number(row.version),
          },
          references: refs,
          visibilityIds: ids,
          topicPath: list(JSON.parse(String(row.scope)).topicPath),
          subtype: String(row.kind),
          eventAt: row.valid_from ? String(row.valid_from) : null,
          provenance: {
            source: "memory",
            actor: null,
            time: String(row.updated_at),
          },
        },
      ]);
    }
    for (const owner of heads.keys())
      if (!wanted.has(owner)) this.replace(owner, null, []);
    // Do not retain every old document in memory after sources have moved on.
    const live = new Set(sourceRows.map((r) => String(r.id)));
    for (const key of this.materialCache.keys())
      if (!live.has(key)) this.materialCache.delete(key);
    this.signature = signature;
  }

  private replace(
    owner: string,
    identity: string | null,
    units: RetrievalUnit[],
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db
        .prepare("SELECT id FROM retrieval_units WHERE owner=?")
        .all(owner))
        this.db
          .prepare("DELETE FROM retrieval_units_fts WHERE id=?")
          .run(String(row.id));
      this.db.prepare("DELETE FROM retrieval_units WHERE owner=?").run(owner);
      this.db
        .prepare("DELETE FROM retrieval_projection_heads WHERE owner=?")
        .run(owner);
      if (identity)
        this.db
          .prepare("INSERT INTO retrieval_projection_heads VALUES(?,?)")
          .run(owner, identity);
      for (const u of units) {
        this.db
          .prepare(
            "INSERT INTO retrieval_units VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            u.id,
            u.owner,
            u.kind,
            u.title,
            u.text,
            u.context,
            JSON.stringify(u.headingPath),
            JSON.stringify(u.target),
            JSON.stringify(u.references),
            JSON.stringify(u.visibilityIds),
            JSON.stringify(u.topicPath),
            JSON.stringify(u.provenance),
            u.eventAt,
            u.subtype,
          );
        this.db
          .prepare(
            "INSERT INTO retrieval_units_fts(id,title,context,body) VALUES(?,?,?,?)",
          )
          .run(
            u.id,
            indexText(u.title),
            indexText(u.context),
            indexText(u.text.replace(/\[\[[\w-]+\]\]/g, "")),
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
/** ICU segmentation makes Chinese searchable with FTS5's standard BM25. */
export function indexText(text: string) {
  return [...segmenter.segment(text)]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment.toLowerCase())
    .join(" ");
}
export function decodeUnit(row: Row): RetrievalUnit {
  return {
    id: String(row.id),
    owner: String(row.owner),
    kind: String(row.kind) as RetrievalUnit["kind"],
    title: String(row.title),
    text: String(row.text),
    context: String(row.context),
    headingPath: JSON.parse(String(row.heading_path)),
    target: JSON.parse(String(row.target)),
    references: JSON.parse(String(row.references_json)),
    visibilityIds: JSON.parse(String(row.visibility_ids)),
    topicPath: JSON.parse(String(row.topic_path)),
    provenance: JSON.parse(String(row.provenance)) as ProvenanceRef,
    eventAt: row.event_at ? String(row.event_at) : null,
    subtype: String(row.subtype),
  };
}
