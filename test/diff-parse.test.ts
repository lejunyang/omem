import { describe, expect, it } from "vitest";
import { splitPatch, unquotePath } from "../web/src/lib/patch.ts";

const patch = [
  "diff --git a/docs/a.md b/docs/a.md",
  "new file mode 100644",
  "index 00000000..8b5c54d8",
  "--- /dev/null",
  "+++ b/docs/a.md",
  "@@ -0,0 +1,2 @@",
  "+# 标题",
  "++++ 以加号开头的一行",
  "diff --git a/src/x.ts b/src/x.ts",
  "index 11fbaac1..2dfbff61 100644",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,2 +1,2 @@",
  " a",
  "-b",
  "+c",
  "diff --git a/public/old.svg b/public/old.svg",
  "deleted file mode 100644",
  "index 65514a45..00000000",
  "--- a/public/old.svg",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-<svg/>",
  "diff --git a/img/banner.png b/img/banner.png",
  "deleted file mode 100644",
  "index 43605e30..00000000",
  "Binary files a/img/banner.png and /dev/null differ",
  "diff --git a/public/b.png b/mock/assets/b.png",
  "similarity index 100%",
  "rename from public/b.png",
  "rename to mock/assets/b.png",
  "diff --git a/lib/u.ts b/lib/v.ts",
  "similarity index 88%",
  "rename from lib/u.ts",
  "rename to lib/v.ts",
  "index 1111111..2222222 100644",
  "--- a/lib/u.ts",
  "+++ b/lib/v.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
  "diff --git a/my file.txt b/my file.txt",
  "old mode 100644",
  "new mode 100755",
  'diff --git "a/\\345\\233\\276.png" "b/\\345\\233\\276.png"',
  "new file mode 100644",
  "index 0000000..abcdef1",
  'Binary files /dev/null and "b/\\345\\233\\276.png" differ',
  "",
].join("\n");

describe("splitPatch", () => {
  const files = splitPatch(patch);
  const by = (name: string) => files.find((f) => f.name === name)!;

  it("names each file by where it is now and says what happened to it", () => {
    expect(files.map((f) => [f.name, f.status, f.binary])).toEqual([
      ["docs/a.md", "added", false],
      ["src/x.ts", "modified", false],
      ["public/old.svg", "deleted", false],
      ["img/banner.png", "deleted", true],
      ["mock/assets/b.png", "renamed", false],
      ["lib/v.ts", "renamed", false],
      ["run.sh", "modified", false],
      ["my file.txt", "modified", false],
      ["图.png", "added", true],
    ]);
  });

  it("counts only the lines of hunks", () => {
    expect([by("docs/a.md").add, by("docs/a.md").rm]).toEqual([2, 0]);
    expect([by("src/x.ts").add, by("src/x.ts").rm]).toEqual([1, 1]);
    expect(by("img/banner.png").add + by("img/banner.png").rm).toBe(0);
  });

  it("keeps where a moved file came from, the blob ids and a real mode change", () => {
    expect(by("mock/assets/b.png")).toMatchObject({ oldName: "public/b.png", similarity: 100, hunks: false });
    expect(by("lib/v.ts")).toMatchObject({ oldName: "lib/u.ts", similarity: 88, hunks: true, oldMode: null });
    expect(by("img/banner.png")).toMatchObject({ oldOid: "43605e30", newOid: null, oldName: null });
    expect(by("run.sh")).toMatchObject({ oldMode: "100644", newMode: "100755", hunks: false });
    expect(by("src/x.ts")).toMatchObject({ oldMode: null, newMode: null, oldName: null });
  });

  it("decodes paths Git quotes", () => {
    expect(unquotePath('"a/\\345\\233\\276 \\"x\\".png"')).toBe('a/图 "x".png');
    expect(unquotePath("plain/path")).toBe("plain/path");
  });
});
