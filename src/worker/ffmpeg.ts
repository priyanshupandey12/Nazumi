import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = ffprobeStatic.path;

if (!FFMPEG) {
  throw new Error(
    "ffmpeg binary not found. Run `pnpm install` so ffmpeg-static can download it.",
  );
}


const SEGMENT_SECONDS = 4;

export type Rung = {
  name: string;
  height: number;

  videoBitrate: number;
  maxrate: number;
  bufsize: number;
  audioBitrate: number;
};


const LADDER: Rung[] = [
  { name: "360p", height: 360, videoBitrate: 800, maxrate: 856, bufsize: 1200, audioBitrate: 96 },
  { name: "480p", height: 480, videoBitrate: 1400, maxrate: 1498, bufsize: 2100, audioBitrate: 128 },
  { name: "720p", height: 720, videoBitrate: 2800, maxrate: 2996, bufsize: 4200, audioBitrate: 128 },
  { name: "1080p", height: 1080, videoBitrate: 5000, maxrate: 5350, bufsize: 7500, audioBitrate: 192 },
];

export type SubtitleStream = {
  /** Index among subtitle streams, which is what `-map 0:s:N` takes. */
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
};

export type VideoMetadata = {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  subtitles: SubtitleStream[];
};


export const probeVideo = async (inputPath: string): Promise<VideoMetadata> => {
  const raw = await run(FFPROBE, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ]);

  const parsed = JSON.parse(raw) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      tags?: { language?: string; title?: string };
    }>;
  };

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");

  if (!videoStream?.width || !videoStream?.height) {
    throw new Error("No decodable video stream found in the uploaded file.");
  }

  return {
    durationSeconds: Math.round(Number(parsed.format?.duration ?? 0)),
    width: videoStream.width,
    height: videoStream.height,
    fps: parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    subtitles: streams
      .filter((s) => s.codec_type === "subtitle")
      .map((s, index) => ({
        index,
        codec: s.codec_name ?? "unknown",
        language: s.tags?.language?.trim() || null,
        title: s.tags?.title?.trim() || null,
      })),
  };
};

/**
 * Bitmap subtitle formats are pictures of text, not text, so there is nothing
 * to turn into WebVTT without running OCR over them.
 */
const TEXT_SUBTITLE_CODECS = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "webvtt",
  "mov_text",
  "text",
]);

export type ExtractedCaption = {
  path: string;
  language: string;
  label: string;
};

/** A readable name for a track whose metadata says little. */
const labelFor = (stream: SubtitleStream, fallbackIndex: number): string => {
  if (stream.title) return stream.title;

  if (stream.language) {
    try {
      const name = new Intl.DisplayNames(["en"], { type: "language" }).of(
        stream.language,
      );
      if (name && name !== stream.language) return name;
    } catch {
      // An unrecognised tag just falls through to the raw code.
    }
    return stream.language;
  }

  return `Track ${fallbackIndex + 1}`;
};

/**
 * Pulls text subtitle tracks out of the source and converts them to WebVTT,
 * which is the only format a browser `<track>` reads.
 *
 * A track that will not convert is skipped rather than failing the job — the
 * video is still worth publishing without its captions.
 */
export const extractCaptions = async (
  inputPath: string,
  outputDir: string,
  subtitles: SubtitleStream[],
): Promise<ExtractedCaption[]> => {
  const usable = subtitles.filter((stream) =>
    TEXT_SUBTITLE_CODECS.has(stream.codec),
  );

  if (usable.length === 0) return [];

  await mkdir(outputDir, { recursive: true });

  const extracted: ExtractedCaption[] = [];
  const seen = new Set<string>();

  for (const [position, stream] of usable.entries()) {
    // The language is the unique key per video, so a file with two unlabelled
    // tracks cannot write both to the same row.
    let language = stream.language ?? `und-${position}`;
    if (seen.has(language)) language = `${language}-${position}`;
    seen.add(language);

    const target = path.join(outputDir, `${language}.vtt`);

    try {
      await run(FFMPEG, [
        "-hide_banner",
        "-loglevel", "error",
        "-i", inputPath,
        "-map", `0:s:${stream.index}`,
        "-c:s", "webvtt",
        "-y",
        target,
      ]);

      extracted.push({
        path: target,
        language,
        label: labelFor(stream, position),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[ffmpeg] could not extract subtitle ${stream.index}: ${reason}`);
    }
  }

  return extracted;
};


const parseFrameRate = (value: string | undefined): number => {
  if (!value) return 30;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return 30;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
};

export const selectRungs = (sourceHeight: number): Rung[] => {
  const usable = LADDER.filter((rung) => rung.height <= sourceHeight);
  if (usable.length > 0) return usable;


  const evenHeight = sourceHeight - (sourceHeight % 2);
  return [{ ...LADDER[0]!, height: evenHeight }];
};

export type HlsResult = {
  outputDir: string;
  masterPlaylist: string;
  rungs: Rung[];
  metadata: VideoMetadata;
};


export const transcodeToHls = async (
  inputPath: string,
  outputDir: string,
  onProgress?: (percent: number) => void,
): Promise<HlsResult> => {
  const metadata = await probeVideo(inputPath);
  const rungs = selectRungs(metadata.height);


  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    rungs.map((rung) => mkdir(path.join(outputDir, rung.name), { recursive: true })),
  );

  const args = buildHlsArgs(inputPath, outputDir, rungs, metadata);


  const runOptions: RunOptions =
    onProgress && metadata.durationSeconds > 0
      ? {
          onProgress: (seconds) =>
            onProgress(Math.min(99, Math.round((seconds / metadata.durationSeconds) * 100))),
        }
      : {};

  await run(FFMPEG, args, runOptions);

  return {
    outputDir,
    masterPlaylist: path.join(outputDir, "master.m3u8"),
    rungs,
    metadata,
  };
};

const buildHlsArgs = (
  inputPath: string,
  outputDir: string,
  rungs: Rung[],
  metadata: VideoMetadata,
): string[] => {

  const gop = Math.round(metadata.fps * 2);


  const splitOutputs = rungs.map((_, i) => `[v${i}]`).join("");
  const scaleChains = rungs
    .map((rung, i) => `[v${i}]scale=-2:${rung.height}[v${i}out]`)
    .join(";");
  const filterComplex = `[0:v]split=${rungs.length}${splitOutputs};${scaleChains}`;

  const args = [
    "-hide_banner",
    "-nostats",
    "-loglevel", "error",
    "-progress", "pipe:1",
    "-y",
    "-i", inputPath,
    "-filter_complex", filterComplex,
  ];

  rungs.forEach((rung, i) => {
    args.push(
      "-map", `[v${i}out]`,
      `-c:v:${i}`, "libx264",
      `-b:v:${i}`, `${rung.videoBitrate}k`,
      `-maxrate:v:${i}`, `${rung.maxrate}k`,
      `-bufsize:v:${i}`, `${rung.bufsize}k`,
    );
  });

  args.push(
    "-preset", "veryfast",
    "-profile:v", "main",
    "-crf", "20",
    "-sc_threshold", "0",
    "-g", String(gop),
    "-keyint_min", String(gop),
    "-pix_fmt", "yuv420p",
  );

  if (metadata.hasAudio) {
    rungs.forEach((rung, i) => {
      args.push(
        "-map", "a:0",
        `-c:a:${i}`, "aac",
        `-b:a:${i}`, `${rung.audioBitrate}k`,
        `-ac:a:${i}`, "2",
      );
    });
  }

  
  const varStreamMap = rungs
    .map((rung, i) =>
      metadata.hasAudio ? `v:${i},a:${i},name:${rung.name}` : `v:${i},name:${rung.name}`,
    )
    .join(" ");

  args.push(
    "-f", "hls",
    "-hls_time", String(SEGMENT_SECONDS),
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", path.join(outputDir, "%v", "seg_%03d.ts"),
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", varStreamMap,
    path.join(outputDir, "%v", "index.m3u8"),
  );

  return args;
};

type RunOptions = { onProgress?: (outTimeSeconds: number) => void };


const run = (bin: string, args: string[], options: RunOptions = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.onProgress) reportProgress(text, options.onProgress);
    });

    child.stderr.on("data", (chunk: Buffer) => {

      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(
        new Error(
          `${path.basename(bin)} exited with code ${code}${stderr ? `:\n${stderr.trim()}` : ""}`,
        ),
      );
    });
  });


const reportProgress = (text: string, onProgress: (seconds: number) => void) => {
  for (const line of text.split("\n")) {
    const [key, value] = line.split("=");
    if (key?.trim() === "out_time_us" && value) {
      const micros = Number(value.trim());
      if (Number.isFinite(micros) && micros >= 0) onProgress(micros / 1_000_000);
    }
  }
};

/** Where in the video to grab poster frames from. */
const THUMBNAIL_POINTS = [0.1, 0.5, 0.9] as const;

export type ThumbnailFrame = {
  path: string;
  position: number;
  atSeconds: number;
};

/**
 * Pulls a few candidate poster frames out of the source.
 *
 * Seeking before `-i` rather than after means ffmpeg jumps straight to the
 * keyframe instead of decoding from the start, so three frames out of a long
 * video cost about as much as one.
 *
 * A frame that cannot be read is skipped rather than failing the job: a
 * missing poster is a cosmetic problem, a failed transcode is not.
 */
export const extractThumbnails = async (
  inputPath: string,
  outputDir: string,
  durationSeconds: number,
): Promise<ThumbnailFrame[]> => {
  await mkdir(outputDir, { recursive: true });

  const frames: ThumbnailFrame[] = [];

  for (const [index, fraction] of THUMBNAIL_POINTS.entries()) {
    // A very short clip would otherwise seek past its own end.
    const at = Math.max(0, Math.min(durationSeconds * fraction, durationSeconds - 0.1));
    const target = path.join(outputDir, `thumb_${index}.jpg`);

    try {
      await run(FFMPEG, [
        "-hide_banner",
        "-loglevel", "error",
        "-ss", at.toFixed(2),
        "-i", inputPath,
        "-frames:v", "1",
        // Width capped, height kept even for any later encode.
        "-vf", "scale=1280:-2",
        "-q:v", "3",
        "-y",
        target,
      ]);

      frames.push({ path: target, position: index, atSeconds: at });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[ffmpeg] could not grab frame at ${at}s: ${reason}`);
    }
  }

  return frames;
};
