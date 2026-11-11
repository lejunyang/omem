import { relTime } from "../store";

/** What the last sync of a repository space found (settings.codeIndexState, src/sources/code-baseline.ts). */
export type CodeIndexState = {
  mode: "baseline" | "directory";
  ref?: string | null;
  commit?: string | null;
  committedAt?: string | null;
  subject?: string | null;
  dirty?: boolean;
  indexedAt?: string;
  fetchedAt?: string;
  error?: string | null;
  errorAt?: string | null;
  branchErrors?: Record<string, string>;
};

/** One line for a repository row: which ref and commit the index is at, and how long ago. */
export function codeIndexLabel(s: { settings?: Record<string, any> }) {
  const st = s.settings?.codeIndexState as CodeIndexState | undefined;
  if (!st) return s.settings?.lastSync ? `${relTime(String(s.settings.lastSync))}同步（按目录）` : "还没同步";
  const at = `${relTime(st.indexedAt ?? String(s.settings?.lastSync ?? ""))}同步`;
  const commit = st.commit ? st.commit.slice(0, 8) : "?";
  const where = st.mode === "baseline" ? `基线 ${st.ref} @ ${commit}` : `目录 · ${st.ref ?? "游离 HEAD"} @ ${commit}${st.dirty ? "（有未提交改动）" : ""}`;
  return `${where} · ${at}${st.error ? " · 上次同步出错" : ""}`;
}
