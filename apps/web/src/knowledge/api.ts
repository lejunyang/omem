import type {
  KnowledgeDocument,
  KnowledgeCitation,
  WikiPageBrief,
  KnowledgeRole,
  SectionStatus,
  PageMaintenanceStatus,
} from "../../../../packages/contracts/src/knowledge";
export type ArticleMeta = {
  role?: KnowledgeRole;
  children?: string[];
  key: string;
  title: string;
  publishedTitle?: string;
  planChanged?: boolean;
  summary: string;
  category: string;
  topicPath?: string[];
  current: boolean;
  revision: string;
  model: string;
  reviewedBy: string;
  generatedAt: string;
  questionCount: number;
  reading?: WikiPageBrief;
};
export type Citation = KnowledgeCitation & {
  actionable: boolean;
  unavailableReason?: string | null;
  current?: boolean;
  resolved?: {
    kind: "article" | "material";
    key: string;
    revision?: string;
    digest?: string;
    section?: string;
    title: string;
    startLine?: number;
    endLine?: number;
  } | null;
};
export type Article = ArticleMeta & {
  document: KnowledgeDocument;
  citations: Citation[];
  sectionStatus?: Record<string, SectionStatus>;
};
export type PlannedPage = {
  key: string;
  role: KnowledgeRole;
  plan: WikiPageBrief | null;
  state: string;
  error?: string;
  maintenance?: PageMaintenanceStatus | null;
};
export type KnowledgeFrame = {
  kind: "knowledge" | "citation" | "source";
  id: string;
  title: string;
};
export async function knowledgeApi<T>(
  prefix: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = sessionStorage.getItem("omem-token");
  const response = await fetch(prefix + path, {
    ...init,
    headers: {
      ...(init?.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Error(body.error || `请求失败 (${response.status})`);
  }
  return response.json();
}
export const knowledgeFrame = (
  key: string,
  title: string,
  revision?: string,
  section?: string,
): KnowledgeFrame => ({
  kind: "knowledge",
  id: JSON.stringify({ key, revision, section }),
  title,
});
