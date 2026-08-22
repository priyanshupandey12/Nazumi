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

export type VideoMetadata = {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
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
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
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
  };
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
