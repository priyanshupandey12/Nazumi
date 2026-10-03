import { describe, expect, it } from "vitest";
import { selectRungs } from "../../src/worker/ffmpeg.js";

describe("selectRungs", () => {
  it("keeps only rungs at or below the source height", () => {
    expect(selectRungs(720).map((r) => r.name)).toEqual(["360p", "480p", "720p"]);
    expect(selectRungs(1080).map((r) => r.name)).toEqual([
      "360p",
      "480p",
      "720p",
      "1080p",
    ]);
  });

  it("never upscales a source smaller than the lowest rung", () => {
    const rungs = selectRungs(240);
    expect(rungs).toHaveLength(1);
    expect(rungs[0]!.height).toBe(240);
  });

  it("rounds an odd source height down to even, because h264 requires it", () => {
    // 1920x945 screen recordings are real; an odd height makes libx264 fail.
    expect(selectRungs(241)[0]!.height).toBe(240);
  });

  it("includes a rung whose height exactly matches the source", () => {
    expect(selectRungs(480).map((r) => r.name)).toEqual(["360p", "480p"]);
  });
});
