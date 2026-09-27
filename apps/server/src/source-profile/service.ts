import type { DatabaseSync } from "node:sqlite";
import { tokenize } from "../retrieval/keyword.js";

type Row = Record<string, unknown>;

export const PROFILER_VERSION = "rule-based@1";

export type DiscourseKind =
  | "definition"
  | "claim"
  | "constraint"
  | "history"
  | "plan"
  | "question"
  | "instruction"
  | "example"
  | "noise";

export type Tense = "present" | "future" | "past" | "unknown";

export type DiscourseSegment = {
  ordinal: number;
  kind: DiscourseKind;
  /** Nearest preceding markdown heading, kept so anaphoric paragraphs (上述…)
   *  can recover their parent context without asking the owner. */
  parentHeading: string | null;
  tense: Tense;
  refParent: boolean;
  tags: string[];
  snippet: string;
};

export type TitleNode = { level: number; text: string; ordinal: number };

export type SourceProfile = {
  sourceRevisionId: string;
  profileGeneration: number;
  profilerVersion: string;
  carrierType: "markdown" | "plaintext";
  languages: string[];
  titlePath: TitleNode[];
  coverageGaps: string[];
  domainCandidates: string[];
  topicCandidates: string[];
  projectCandidates: string[];
  discourseSegments: DiscourseSegment[];
  answerableTopics: string[];
  temporalNotes: string[];
  explicitLinks: string[];
  derived: true;
  evidenceRefs: string[];
  status: "ok" | "partial" | "failed";
  error: string | null;
  createdAt: string;
};

const STOPWORDS = new Set([
  "的", "了", "和", "是", "在", "我们", "我", "你", "他", "她", "它", "他们",
  "一个", "没有", "这个", "那个", "可以", "这", "那", "与", "及", "或", "等",
  "为", "对", "从", "到", "后", "前", "中", "上", "下", "要", "会", "能",
  "就", "都", "而", "the", "a", "an", "of", "to", "in", "and", "or", "is",
  "are", "was", "be", "for", "on", "with", "as", "at", "by", "it", "this",
  "that", "which", "from",
]);

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

type Classified = {
  kind: DiscourseKind;
  tags: string[];
  tense: Tense;
  refParent: boolean;
};

function classify(text: string): Classified {
  const t = text.trim();
  if (/^\[图片\]/.test(t))
    return { kind: "noise", tags: ["image"], tense: "unknown", refParent: false };
  if (t.length < 4)
    return { kind: "noise", tags: [], tense: "unknown", refParent: false };

  const present = /当前|目前|现在|现状|现有/.test(t);
  const future =
    /未来|将来|将会|将|计划|预计|下一步|打算|后续|roadmap|将要|可能会|远期/.test(t);
  const past = /昨天|上周|上个月|此前|之前|过去|20\d{2}年/.test(t);
  const tense: Tense = future ? "future" : past ? "past" : present ? "present" : "unknown";
  const refParent = /上述|该|此|以上|前述|前文|所述/.test(t);

  // Code / examples first (G03): TODOs, SQL, fixtures and shell commands are material
  // to parse, never owner instructions to execute.
  const codeLike =
    /```/.test(t) ||
    /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE|DROP TABLE|CREATE INDEX)\b/i.test(
      t,
    ) ||
    /\bTODO\b|\bFIXME\b|console\.log|=>|function\s*\(|^\s*(const|let|var|def |func |public |private |class |import |from )/m.test(
      t,
    ) ||
    /;\s*$/m.test(t) ||
    /\b(npm|npx|pnpm|bash|powershell|curl|git)\s+\S/.test(t);

  if (codeLike)
    return { kind: "example", tags: ["code"], tense, refParent };
  if (/\?\s*$|？\s*$|^(吗|呢|如何|为什么|怎么|请问|是否|能不能|能否)/.test(t))
    return { kind: "question", tags: [], tense, refParent };
  if (/必须|不得|禁止|严禁|不应|不准|must not|shall not|MUST NOT/.test(t))
    return { kind: "constraint", tags: [], tense, refParent };
  if (/例如|比如|譬如|e\.g\.|such as|举例|如下例/.test(t))
    return { kind: "example", tags: [], tense, refParent };
  if (/是指|定义为|被定义|称为|is defined as|即[:：]/.test(t))
    return { kind: "definition", tags: [], tense, refParent };
  if (future) return { kind: "plan", tags: [], tense, refParent };
  if (past && !present) return { kind: "history", tags: [], tense, refParent };
  if (/请|你需要|要求|务必|按如下|步骤/.test(t))
    return { kind: "instruction", tags: [], tense, refParent };
  return { kind: "claim", tags: [], tense, refParent };
}

export class SourceProfileService {
  constructor(private readonly db: DatabaseSync) {}

  latest(revisionId: string): SourceProfile | null {
    const row = this.db
      .prepare(
        "SELECT * FROM source_profiles WHERE source_revision_id=? ORDER BY profile_generation DESC LIMIT 1",
      )
      .get(revisionId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** Synchronous, deterministic, best-effort. Callers wrap this so a profiling
   *  failure never prevents the original evidence from being captured/read. */
  persistForRevision(revisionId: string): SourceProfile {
    const row = this.db
      .prepare("SELECT title,body,created_at FROM revisions WHERE id=?")
      .get(revisionId) as Row | undefined;
    if (!row) throw Error(`REVISION_NOT_FOUND: ${revisionId}`);
    const fragments = this.db
      .prepare(
        "SELECT id,ordinal,text FROM fragments WHERE revision_id=? ORDER BY ordinal",
      )
      .all(revisionId) as Row[];
    const body = JSON.parse(String(row.body)) as {
      context?: Record<string, unknown>;
      parts?: unknown[];
    };
    const profile = analyze({
      title: String(row.title),
      body,
      fragments: fragments.map((f) => ({
        id: String(f.id),
        ordinal: Number(f.ordinal),
        text: String(f.text),
      })),
    });
    const generationRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(profile_generation),0) AS maxgen FROM source_profiles WHERE source_revision_id=?",
      )
      .get(revisionId) as { maxgen: number };
    const generation = Number(generationRow.maxgen) + 1;
    profile.profileGeneration = generation;
    profile.sourceRevisionId = revisionId;
    this.write(profile);
    return profile;
  }

  recordFailure(revisionId: string, error: unknown): void {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");
    try {
      this.db
        .prepare(
          `INSERT INTO source_profiles(
             source_revision_id,profile_generation,profiler_version,carrier_type,
             languages,title_path,coverage_gaps,domain_candidates,topic_candidates,
             project_candidates,discourse_segments,answerable_topics,temporal_notes,
             explicit_links,derived,evidence_refs,status,error,created_at
           ) VALUES(?,1,?, 'unknown','[]','[]','[]','[]','[]','[]','[]','[]','[]','[]',0,'[]','failed',?,?)`,
        )
        .run(
          revisionId,
          PROFILER_VERSION,
          message.slice(0, 1000),
          new Date().toISOString(),
        );
    } catch {
      // Source remains readable; profiling is optional navigation metadata.
    }
  }

  private write(profile: SourceProfile): void {
    this.db
      .prepare(
        `INSERT INTO source_profiles(
           source_revision_id,profile_generation,profiler_version,carrier_type,
           languages,title_path,coverage_gaps,domain_candidates,topic_candidates,
           project_candidates,discourse_segments,answerable_topics,temporal_notes,
           explicit_links,derived,evidence_refs,status,error,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        profile.sourceRevisionId,
        profile.profileGeneration,
        profile.profilerVersion,
        profile.carrierType,
        JSON.stringify(profile.languages),
        JSON.stringify(profile.titlePath),
        JSON.stringify(profile.coverageGaps),
        JSON.stringify(profile.domainCandidates),
        JSON.stringify(profile.topicCandidates),
        JSON.stringify(profile.projectCandidates),
        JSON.stringify(profile.discourseSegments),
        JSON.stringify(profile.answerableTopics),
        JSON.stringify(profile.temporalNotes),
        JSON.stringify(profile.explicitLinks),
        profile.derived ? 1 : 0,
        JSON.stringify(profile.evidenceRefs),
        profile.status,
        null,
        profile.createdAt,
      );
  }
}

function fromRow(row: Row): SourceProfile {
  const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
  return {
    sourceRevisionId: String(row.source_revision_id),
    profileGeneration: Number(row.profile_generation),
    profilerVersion: String(row.profiler_version),
    carrierType: String(row.carrier_type) as SourceProfile["carrierType"],
    languages: parse<string[]>(row.languages),
    titlePath: parse<TitleNode[]>(row.title_path),
    coverageGaps: parse<string[]>(row.coverage_gaps),
    domainCandidates: parse<string[]>(row.domain_candidates),
    topicCandidates: parse<string[]>(row.topic_candidates),
    projectCandidates: parse<string[]>(row.project_candidates),
    discourseSegments: parse<DiscourseSegment[]>(row.discourse_segments),
    answerableTopics: parse<string[]>(row.answerable_topics),
    temporalNotes: parse<string[]>(row.temporal_notes),
    explicitLinks: parse<string[]>(row.explicit_links),
    derived: true,
    evidenceRefs: parse<string[]>(row.evidence_refs),
    status: String(row.status) as SourceProfile["status"],
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
  };
}

export function analyze(input: {
  title: string;
  body: {
    context?: Record<string, unknown>;
    parts?: unknown[];
  };
  fragments: { id: string; ordinal: number; text: string }[];
}): SourceProfile {
  const fragments = input.fragments;
  const hasHeading = fragments.some((f) => HEADING.test(f.text.trim()));
  const carrierType: SourceProfile["carrierType"] = hasHeading
    ? "markdown"
    : "plaintext";

  const titlePath: TitleNode[] = [];
  const segments: DiscourseSegment[] = [];
  const coverageGaps: string[] = [];
  const temporalNotes = new Set<string>();
  const headingStack: string[] = [];

  for (const fragment of fragments) {
    const trimmed = fragment.text.trim();
    const headingMatch = HEADING.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = text;
      titlePath.push({ level, text, ordinal: fragment.ordinal });
      continue;
    }
    const parentHeading = [...headingStack].filter(Boolean).pop() ?? null;
    const c = classify(fragment.text);
    if (c.tense === "present") temporalNotes.add("present: 当前/目前被提及");
    if (c.tense === "future") temporalNotes.add("future: 未来/计划被提及");
    if (c.tense === "past") temporalNotes.add("past: 历史/既往被提及");
    if (c.refParent) temporalNotes.add("reference: 段内指称依赖父标题");
    segments.push({
      ordinal: fragment.ordinal,
      kind: c.kind,
      parentHeading,
      tense: c.tense,
      refParent: c.refParent,
      tags: c.tags,
      snippet: trimmed.slice(0, 160),
    });
    if (/^\[图片\]/.test(trimmed))
      coverageGaps.push(`image fragment at ordinal ${fragment.ordinal}`);
    if (trimmed.includes("|"))
      coverageGaps.push(`table-like fragment at ordinal ${fragment.ordinal}`);
    if (trimmed.length > 1500)
      coverageGaps.push(`long fragment at ordinal ${fragment.ordinal}`);
  }

  // Topic candidates: heading texts + frequent non-stopword terms.
  const freq = new Map<string, number>();
  for (const fragment of fragments)
    for (const term of tokenize(fragment.text)) {
      if (STOPWORDS.has(term.toLowerCase()) || term.length < 2) continue;
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
  const frequentTopics = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term]) => term);
  const topicCandidates = [
    ...new Set([...titlePath.map((h) => h.text), ...frequentTopics]),
  ].slice(0, 12);

  // Language detection from raw character counts.
  let cjk = 0;
  let latin = 0;
  for (const fragment of fragments)
    for (const ch of fragment.text) {
      if (/[一-鿿]/.test(ch)) cjk++;
      else if (/[A-Za-z]/.test(ch)) latin++;
    }
  const languages: string[] =
    cjk >= 10 && latin >= 10
      ? ["zh", "en"]
      : cjk >= 10
        ? ["zh"]
        : latin >= 3
          ? ["en"]
          : ["unknown"];

  const context = input.body.context ?? {};
  const projectCandidates = [
    context.application,
    context.conversationId,
    context.runId,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  const explicitLinks: string[] = [];
  for (const part of input.body.parts ?? []) {
    if (part && typeof part === "object" && "url" in part) {
      const url = (part as { url?: unknown }).url;
      if (typeof url === "string") explicitLinks.push(url);
    }
  }

  return {
    sourceRevisionId: "",
    profileGeneration: 1,
    profilerVersion: PROFILER_VERSION,
    carrierType,
    languages,
    titlePath,
    coverageGaps,
    domainCandidates: topicCandidates,
    topicCandidates,
    projectCandidates,
    discourseSegments: segments,
    answerableTopics: titlePath.map((h) => h.text),
    temporalNotes: [...temporalNotes],
    explicitLinks,
    derived: true,
    evidenceRefs: fragments.map((f) => f.id),
    status: coverageGaps.length ? "partial" : "ok",
    error: null,
    createdAt: new Date().toISOString(),
  };
}
