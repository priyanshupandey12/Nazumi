import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { uploadRawToCloudinary } from "../utils/cloudinary.js";
import type { Rung } from "./ffmpeg.js";


const UPLOAD_CONCURRENCY = 6;

export type UploadedVariant = {
  name: string;
  height: number;
  bandwidth: number;
  playlistUrl: string;
  segmentCount: number;
};

export type UploadedHls = {
  masterPlaylistUrl: string;
  variants: UploadedVariant[];
};


export type RawUploader = (localPath: string, publicId: string) => Promise<string>;

const cloudinaryUploader: RawUploader = async (localPath, publicId) => {
  const result = await uploadRawToCloudinary(localPath, publicId);
  return result.secure_url;
};


export const uploadHlsDirectory = async (
  outputDir: string,
  rungs: Rung[],
  prefix: string,
  onProgress?: (percent: number) => void,
  upload: RawUploader = cloudinaryUploader,
): Promise<UploadedHls> => {
  const variantFiles = await Promise.all(
    rungs.map(async (rung) => {
      const dir = path.join(outputDir, rung.name);
      const entries = await readdir(dir);
      return { rung, dir, segments: entries.filter((f) => f.endsWith(".ts")).sort() };
    }),
  );

  const totalSegments = variantFiles.reduce((sum, v) => sum + v.segments.length, 0);
  if (totalSegments === 0) {
    throw new Error("ffmpeg produced no .ts segments — nothing to upload.");
  }

  let uploaded = 0;
  const variants: UploadedVariant[] = [];

  for (const { rung, dir, segments } of variantFiles) {
    const segmentUrls = new Map<string, string>();

    await forEachWithConcurrency(segments, UPLOAD_CONCURRENCY, async (segment) => {
      const url = await upload(path.join(dir, segment), `${prefix}/${rung.name}/${segment}`);
      segmentUrls.set(segment, url);
      uploaded += 1;
      onProgress?.(Math.round((uploaded / totalSegments) * 100));
    });

    const playlistPath = path.join(dir, "index.m3u8");
    const rewritten = rewriteSegmentUrls(await readFile(playlistPath, "utf8"), segmentUrls);
    await writeFile(playlistPath, rewritten, "utf8");

    const playlistUrl = await upload(playlistPath, `${prefix}/${rung.name}/index.m3u8`);

    variants.push({
      name: rung.name,
      height: rung.height,
      bandwidth: (rung.videoBitrate + rung.audioBitrate) * 1000,
      playlistUrl,
      segmentCount: segments.length,
    });
  }

  const masterPath = path.join(outputDir, "master.m3u8");
  const variantUrls = new Map(variants.map((v) => [`${v.name}/index.m3u8`, v.playlistUrl]));
  const master = rewriteSegmentUrls(await readFile(masterPath, "utf8"), variantUrls);
  await writeFile(masterPath, master, "utf8");

  const masterPlaylistUrl = await upload(masterPath, `${prefix}/master.m3u8`);

  return { masterPlaylistUrl, variants };
};


const rewriteSegmentUrls = (playlist: string, urls: Map<string, string>): string =>
  playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;

      const replacement = urls.get(trimmed.replace(/\\/g, "/"));
      if (!replacement) {
        throw new Error(`Playlist references "${trimmed}", which was never uploaded.`);
      }
      return replacement;
    })
    .join("\n");


const forEachWithConcurrency = async <T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await task(item);
    }
  });

  await Promise.all(workers);
};
