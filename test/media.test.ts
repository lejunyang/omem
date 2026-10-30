import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { all, run as sql } from "../src/core/db.ts";
import { candidates, compressedSummary, deleteCompressedOriginals, encodePlan, mediaJobState, startMediaJob, type CompressOptions } from "../src/core/media.ts";
import { hasStoredFile, storedName } from "../src/core/stored-files.ts";
import { scanStorage } from "../src/core/storage-scan.ts";
import { toolCommand } from "../src/core/tools.ts";
import { keepOriginal } from "../src/sources/import.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

const opts = (o: Partial<CompressOptions> = {}): CompressOptions => ({ types: ["image", "video", "audio"], mode: "lossy", quality: "medium", maxSide: 0, minBytes: 0, deleteOriginals: true, limit: 0, ...o });
const ALL = ["libwebp", "libwebp_anim", "libsvtav1", "libx264", "libopus", "aac", "flac"];

describe("media compression", () => {
  it("plans each kind by mode and available encoders", () => {
    expect(encodePlan("a.png", "image", opts({ mode: "lossless" }), ALL)).toMatchObject({ ext: ".webp", codec: "webp-lossless" });
    expect(encodePlan("a.gif", "image", opts(), ALL)).toMatchObject({ ext: ".webp", args: expect.arrayContaining(["libwebp_anim", "-loop"]) });
    expect(encodePlan("a.mov", "video", opts(), ALL)).toMatchObject({ ext: ".mp4", codec: "av1" });
    expect(encodePlan("a.mov", "video", opts(), ["libx264", "aac"])).toMatchObject({ codec: "h264" });
    expect(encodePlan("a.mov", "video", opts({ mode: "lossless" }), ALL)).toMatch(/没有无损/);
    expect(encodePlan("a.wav", "audio", opts({ mode: "lossless" }), ALL)).toMatchObject({ ext: ".flac" });
    expect(encodePlan("a.mp3", "audio", opts(), ALL)).toMatchObject({ ext: ".ogg", codec: "opus" });
    expect(encodePlan("a.png", "image", opts(), [])).toMatch(/libwebp/);
    const scaled = encodePlan("a.mp4", "video", opts({ maxSide: 1280 }), ALL) as { args: string[] };
    expect(scaled.args.join(" ")).toContain("min(iw,1280)");
    // Odd-sized video still encodes: sides are rounded to even.
    expect((encodePlan("a.mp4", "video", opts(), ALL) as { args: string[] }).args.join(" ")).toContain("trunc(iw/2)*2");
    expect((encodePlan("a.png", "image", opts(), ALL) as { args: string[] }).args).not.toContain("-vf");
  });

  it("picks candidates and skips what was tried with the same settings", () => {
    writeFileSync(join(app.filesDir, "bbbbbbbbbbbbbbb1.png"), Buffer.alloc(3000));
    writeFileSync(join(app.filesDir, "bbbbbbbbbbbbbbb2.jpg"), Buffer.alloc(2000));
    writeFileSync(join(app.filesDir, "bbbbbbbbbbbbbbb3.webp"), Buffer.alloc(2000));
    writeFileSync(join(app.filesDir, "bbbbbbbbbbbbbbb4.pdf"), Buffer.alloc(2000));
    const names = (o: CompressOptions) => candidates(app, o).map((c) => c.name).filter((n) => n.startsWith("bbbb"));
    expect(names(opts())).toEqual(["bbbbbbbbbbbbbbb1.png", "bbbbbbbbbbbbbbb2.jpg"]);
    // Lossless leaves JPEG alone: re-encoding it losslessly only grows it.
    expect(names(opts({ mode: "lossless" }))).toEqual(["bbbbbbbbbbbbbbb1.png"]);
    expect(names(opts({ minBytes: 2500 }))).toEqual(["bbbbbbbbbbbbbbb1.png"]);
    sql(app.db, "insert into file_variants(original, status, mode, quality, original_bytes, created_at) values('bbbbbbbbbbbbbbb2.jpg', 'kept', 'lossy', 'medium', 2000, '')");
    expect(names(opts())).toEqual(["bbbbbbbbbbbbbbb1.png"]);
    expect(names(opts({ quality: "low" }))).toEqual(["bbbbbbbbbbbbbbb1.png", "bbbbbbbbbbbbbbb2.jpg"]);
  });

  it("opens the compressed copy under the original name", () => {
    writeFileSync(join(app.filesDir, "ccccccccccccccc2.webp"), Buffer.from("small"));
    sql(app.db, "insert into file_variants(original, status, file, mode, quality, original_bytes, bytes, created_at) values('ccccccccccccccc1.png', 'done', 'ccccccccccccccc2.webp', 'lossy', 'medium', 100, 5, '')");
    expect(storedName(app, "ccccccccccccccc1.png")).toBe("ccccccccccccccc2.webp");
    expect(hasStoredFile(app, "ccccccccccccccc9.png")).toBe(false);
    // The original wins while it is still there.
    writeFileSync(join(app.filesDir, "ccccccccccccccc1.png"), Buffer.alloc(100));
    expect(storedName(app, "ccccccccccccccc1.png")).toBe("ccccccccccccccc1.png");
    expect(compressedSummary(app).originalsOnDisk.files).toBe(1);
    expect(deleteCompressedOriginals(app)).toEqual({ files: 1, bytes: 100 });
    expect(existsSync(join(app.filesDir, "ccccccccccccccc1.png"))).toBe(false);
    expect(storedName(app, "ccccccccccccccc1.png")).toBe("ccccccccccccccc2.webp");
  });

  it("does not bring a compressed original back when it is downloaded again", () => {
    const src = join(app.home, "again.png");
    writeFileSync(src, Buffer.from("same bytes"));
    const name = keepOriginal(app, src);
    const path = join(app.filesDir, name);
    expect(existsSync(path)).toBe(true);
    writeFileSync(join(app.filesDir, "ddddddddddddddd1.webp"), Buffer.from("x"));
    sql(app.db, "insert into file_variants(original, status, file, mode, quality, original_bytes, bytes, created_at) values(?, 'done', 'ddddddddddddddd1.webp', 'lossy', 'medium', 10, 1, '')", name);
    deleteCompressedOriginals(app);
    expect(keepOriginal(app, src)).toBe(name);
    expect(existsSync(path)).toBe(false);
  });

  it.skipIf(!toolCommand("ffmpeg"))("compresses with ffmpeg and keeps references working", async () => {
    const ff = toolCommand("ffmpeg")!;
    const make = (name: string, args: string[]) => {
      const r = spawnSync(ff[0], [...ff.slice(1), "-hide_banner", "-loglevel", "error", "-y", ...args, join(app.filesDir, name)]);
      expect(r.status, String(r.stderr)).toBe(0);
    };
    make("eeeeeeeeeeeeeee1.bmp", ["-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1"]);
    make("eeeeeeeeeeeeeee2.wav", ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"]);
    make("eeeeeeeeeeeeeee3.mp4", ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1", "-c:v", "mjpeg", "-q:v", "2"]);
    sql(app.db, "insert into lark_messages(message_id, chat_id, create_ms, resources) values('om_media', 'oc_1', 0, ?)", JSON.stringify({ k: { type: "image", file: "eeeeeeeeeeeeeee1.bmp" } }));
    const only = (o: CompressOptions) => ({ ...o, minBytes: 5_000 });
    startMediaJob(app, only(opts({ mode: "lossless", types: ["image", "audio"] })));
    for (let i = 0; i < 600 && !mediaJobState(app)?.finishedAt; i++) await new Promise((r) => setTimeout(r, 100));
    const job = mediaJobState(app)!;
    expect(job.error).toBeNull();
    const rows = all<{ original: string; status: string; file: string }>(app.db, "select original, status, file from file_variants where original like 'eeee%' order by original");
    expect(rows.map((r) => [r.original, r.status])).toEqual([["eeeeeeeeeeeeeee1.bmp", "done"], ["eeeeeeeeeeeeeee2.wav", "done"]]);
    expect(rows[0].file).toMatch(/^[a-f0-9]{16}\.webp$/);
    expect(rows[1].file).toMatch(/\.flac$/);
    expect(existsSync(join(app.filesDir, "eeeeeeeeeeeeeee1.bmp"))).toBe(false);
    expect(storedName(app, "eeeeeeeeeeeeeee1.bmp")).toBe(rows[0].file);
    // The storage report counts the copy where the original was referenced.
    const report = scanStorage(app.home);
    expect(report.files.largest.find((f) => f.name === rows[0].file)?.origin).toBe("chat");

    startMediaJob(app, only(opts({ types: ["video"] })));
    for (let i = 0; i < 1200 && !mediaJobState(app)?.finishedAt; i++) await new Promise((r) => setTimeout(r, 100));
    const video = all<{ status: string; file: string | null; error: string | null }>(app.db, "select status, file, error from file_variants where original = 'eeeeeeeeeeeeeee3.mp4'")[0];
    expect(video.status, video.error ?? "").toBe("done");
    expect(video.file).toMatch(/\.mp4$/);
  }, 180_000);
});
