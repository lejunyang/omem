/**
 * One file of a `git diff`: where it was and is now, what happened to it (new, deleted, moved,
 * copied, mode only), whether it is binary, and the blob ids of both sides (to show an image or
 * offer a download when the diff has no lines). `lines` are the file's patch lines after the
 * `diff --git` header line.
 */
export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";
export type DiffMeta = {
  /** Path after the change (before it, for a deleted file). */
  name: string;
  /** Path before a move or copy. */
  oldName: string | null;
  status: FileStatus;
  binary: boolean;
  similarity: number | null;
  oldMode: string | null;
  newMode: string | null;
  oldOid: string | null;
  newOid: string | null;
  hunks: boolean;
};
export type DiffEntry = DiffMeta & { lines: string[]; add: number; rm: number };

export const STATUS_LABEL: Record<FileStatus, string> = { modified: "", added: "新增", deleted: "删除", renamed: "移动", copied: "复制" };

/** A path as Git prints it: C-quoted (octal bytes for non-ASCII, `\"`, `\\`, `\t`…) when it has to be. */
export function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      bytes.push(parseInt(oct, 8));
      i += oct.length;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// `--- a/x` / `+++ b/x`: Git puts a tab after a name with spaces in it.
const side = (s: string) => {
  const t = unquotePath(s.replace(/\t$/, ""));
  return t === "/dev/null" ? null : t.replace(/^[ab]\//, "");
};
const oid = (s: string) => (/^0+$/.test(s) ? null : s);

/** The `a/x b/y` header when nothing else names the file (a mode change of a name with spaces). */
function headNames(head: string): [string | null, string | null] {
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(head);
  if (quoted) return [side(quoted[1]), side(quoted[2])];
  // Unquoted with spaces: both halves are the same name, `a/<name> b/<name>`.
  const half = (head.length - 1) / 2;
  if (Number.isInteger(half) && head[half] === " ") return [side(head.slice(0, half)), side(head.slice(half + 1))];
  return [null, null];
}

export function diffMeta(lines: string[], head = ""): DiffMeta {
  let oldName: string | null | undefined;
  let newName: string | null | undefined;
  let status: FileStatus = "modified";
  let binary = false;
  let similarity: number | null = null;
  let oldMode: string | null = null;
  let newMode: string | null = null;
  let oldOid: string | null = null;
  let newOid: string | null = null;
  let hunks = false;
  for (const l of lines) {
    if (l.startsWith("@@ ")) { hunks = true; break; }
    let m: RegExpExecArray | null;
    if ((m = /^new file mode (\d+)/.exec(l))) { status = "added"; newMode = m[1]; }
    else if ((m = /^deleted file mode (\d+)/.exec(l))) { status = "deleted"; oldMode = m[1]; }
    else if ((m = /^old mode (\d+)/.exec(l))) oldMode = m[1];
    else if ((m = /^new mode (\d+)/.exec(l))) newMode = m[1];
    else if ((m = /^rename from (.+)$/.exec(l))) { status = "renamed"; oldName = unquotePath(m[1]); }
    else if ((m = /^rename to (.+)$/.exec(l))) newName = unquotePath(m[1]);
    else if ((m = /^copy from (.+)$/.exec(l))) { status = "copied"; oldName = unquotePath(m[1]); }
    else if ((m = /^copy to (.+)$/.exec(l))) newName = unquotePath(m[1]);
    else if ((m = /^(?:similarity|dissimilarity) index (\d+)%/.exec(l))) similarity = Number(m[1]);
    else if ((m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?/.exec(l))) { oldOid = oid(m[1]); newOid = oid(m[2]); if (m[3]) oldMode = newMode = oldMode ?? m[3]; }
    else if (l.startsWith("--- ")) oldName ??= side(l.slice(4));
    else if (l.startsWith("+++ ")) newName ??= side(l.slice(4));
    else if ((m = /^Binary files (.+) and (.+) differ$/.exec(l))) { binary = true; oldName ??= side(m[1]); newName ??= side(m[2]); }
    else if (l === "GIT binary patch") binary = true;
  }
  if (oldName === undefined || newName === undefined) {
    const [a, b] = headNames(head);
    if (oldName === undefined) oldName = status === "added" ? null : a;
    if (newName === undefined) newName = status === "deleted" ? null : b;
  }
  const name = newName ?? oldName ?? "?";
  // A plain change of one file names it twice: no “from” to show.
  const from = status === "renamed" || status === "copied" ? oldName ?? null : null;
  // `index a..b 100644` repeats the mode of an unchanged file: only a real change is a mode change.
  if (oldMode && newMode && oldMode === newMode) oldMode = newMode = null;
  return { name, oldName: from, status, binary, similarity, oldMode, newMode, oldOid, newOid, hunks };
}

/** A saved patch split into files. */
export function splitPatch(patch: string): DiffEntry[] {
  return patch
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((chunk) => {
      const all = chunk.split("\n");
      const lines = all.slice(1);
      const meta = diffMeta(lines, all[0]);
      // Count only the lines of hunks: a header's `--- a/x` is not a removed line.
      let add = 0;
      let rm = 0;
      let inHunk = false;
      for (const l of lines) {
        if (l.startsWith("@@ ")) inHunk = true;
        else if (inHunk && l.startsWith("+")) add++;
        else if (inHunk && l.startsWith("-")) rm++;
      }
      return { ...meta, lines, add, rm };
    });
}

/** A mode as people read it: executable or not, a link, a submodule. */
export function modeLabel(mode: string | null) {
  if (!mode) return "";
  if (mode === "100755") return "可执行";
  if (mode === "100644") return "普通文件";
  if (mode === "120000") return "符号链接";
  if (mode === "160000") return "子模块";
  return mode;
}

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
export const isImagePath = (p: string) => IMAGES.has(p.split(".").pop()!.toLowerCase());
