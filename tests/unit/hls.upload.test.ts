import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uploadHlsDirectory } from "../../src/worker/hls.upload.js";
import type { Rung } from "../../src/worker/ffmpeg.js";

const rung = (name: string, height: number): Rung => ({
  name,
  height,
  videoBitrate: 800,
  maxrate: 856,
  bufsize: 1200,
  audioBitrate: 96,
});

let outputDir: string;

/** Writes the directory shape ffmpeg actually produces. */
const writeOutput = async (
  rungs: Rung[],
  segmentsPerRung: number,
  masterSeparator: "\\" | "/",
) => {
  for (const r of rungs) {
    const dir = path.join(outputDir, r.name);
    await mkdir(dir, { recursive: true });

    const segments: string[] = [];
    for (let i = 0; i < segmentsPerRung; i++) {
      const name = `seg_${String(i).padStart(3, "0")}.ts`;
      await writeFile(path.join(dir, name), `payload ${r.name} ${i}`);
      segments.push(`#EXTINF:4.000000,\n${name}`);
    }

    await writeFile(
      path.join(dir, "index.m3u8"),
      `#EXTM3U\n#EXT-X-VERSION:6\n${segments.join("\n")}\n#EXT-X-ENDLIST\n`,
    );
  }

  const variants = rungs
    .map((r) => `#EXT-X-STREAM-INF:BANDWIDTH=1\n${r.name}${masterSeparator}index.m3u8`)
    .join("\n\n");
  await writeFile(path.join(outputDir, "master.m3u8"), `#EXTM3U\n${variants}\n`);
};

beforeEach(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), "hls-test-"));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe("uploadHlsDirectory", () => {
  it("uploads every segment, each variant playlist and the master", async () => {
    const rungs = [rung("360p", 360), rung("720p", 720)];
    await writeOutput(rungs, 3, "/");

    const upload = vi.fn(async (_local: string, publicId: string) => `https://cdn.test/${publicId}`);
    const result = await uploadHlsDirectory(outputDir, rungs, "videos/abc/hls", undefined, upload);

    // 6 segments + 2 variant playlists + 1 master
    expect(upload).toHaveBeenCalledTimes(9);
    expect(result.masterPlaylistUrl).toBe("https://cdn.test/videos/abc/hls/master.m3u8");
    expect(result.variants.map((v) => v.name)).toEqual(["360p", "720p"]);
    expect(result.variants[0]!.segmentCount).toBe(3);
  });

  it("rewrites segment names in a variant playlist to absolute URLs", async () => {
    const rungs = [rung("360p", 360)];
    await writeOutput(rungs, 2, "/");

    await uploadHlsDirectory(
      outputDir,
      rungs,
      "videos/abc/hls",
      undefined,
      async (_local, publicId) => `https://cdn.test/${publicId}`,
    );

    const playlist = await readFile(path.join(outputDir, "360p", "index.m3u8"), "utf8");
    expect(playlist).toContain("https://cdn.test/videos/abc/hls/360p/seg_000.ts");
    expect(playlist).not.toMatch(/^seg_000\.ts$/m);
    // Directives must survive untouched.
    expect(playlist).toContain("#EXT-X-ENDLIST");
  });

  it("normalises the backslashes ffmpeg writes into a master playlist on Windows", async () => {
    // ffmpeg emits `360p\index.m3u8` here. Without normalisation the rewrite
    // finds no match and every upload on Windows fails.
    const rungs = [rung("360p", 360), rung("720p", 720)];
    await writeOutput(rungs, 1, "\\");

    const result = await uploadHlsDirectory(
      outputDir,
      rungs,
      "videos/abc/hls",
      undefined,
      async (_local, publicId) => `https://cdn.test/${publicId}`,
    );

    const master = await readFile(path.join(outputDir, "master.m3u8"), "utf8");
    expect(master).toContain("https://cdn.test/videos/abc/hls/360p/index.m3u8");
    expect(master).toContain("https://cdn.test/videos/abc/hls/720p/index.m3u8");
    expect(master).not.toContain("\\");
    expect(result.variants).toHaveLength(2);
  });

  it("reports progress from 0 to 100 as segments go up", async () => {
    const rungs = [rung("360p", 360), rung("720p", 720)];
    await writeOutput(rungs, 2, "/");

    const seen: number[] = [];
    await uploadHlsDirectory(
      outputDir,
      rungs,
      "videos/abc/hls",
      (percent) => seen.push(percent),
      async (_local, publicId) => `https://cdn.test/${publicId}`,
    );

    expect(seen.at(-1)).toBe(100);
    // Monotonic: a bar that goes backwards reads as a stall.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("refuses to finish when ffmpeg produced no segments", async () => {
    const rungs = [rung("360p", 360)];
    await writeOutput(rungs, 0, "/");

    await expect(
      uploadHlsDirectory(outputDir, rungs, "videos/abc/hls", undefined, async () => "x"),
    ).rejects.toThrow(/no .ts segments/i);
  });

  it("fails loudly when a playlist references something that was never uploaded", async () => {
    const rungs = [rung("360p", 360)];
    await writeOutput(rungs, 1, "/");
    // A playlist pointing at a segment that is not on disk would otherwise
    // produce a master playlist with a dead entry.
    await writeFile(
      path.join(outputDir, "360p", "index.m3u8"),
      "#EXTM3U\n#EXTINF:4,\nmissing.ts\n#EXT-X-ENDLIST\n",
    );

    await expect(
      uploadHlsDirectory(
        outputDir,
        rungs,
        "videos/abc/hls",
        undefined,
        async (_local, publicId) => `https://cdn.test/${publicId}`,
      ),
    ).rejects.toThrow(/never uploaded/i);
  });
});
