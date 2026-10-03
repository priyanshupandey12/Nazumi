import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { video } from "../../src/db/Schema.js";

const videoBytes = () => Buffer.alloc(2048, 1);
const dataUrl = (kb: number) => "data:image/png;base64," + "A".repeat(kb * 1024);

describe("POST /api/videos", () => {
  it("rejects an unauthenticated upload", async () => {
    const res = await request(app)
      .post("/api/videos")
      .attach("video", videoBytes(), { filename: "clip.mp4", contentType: "video/mp4" })
      .field("title", "No session");

    expect(res.status).toBe(401);
  });

  it("requires a title", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/videos")
      .set("Cookie", user.cookie)
      .attach("video", videoBytes(), { filename: "clip.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/title/i);
  });

  it("requires a file", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/videos")
      .set("Cookie", user.cookie)
      .field("title", "No file");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/file/i);
  });

  it("accepts a video and queues it for processing", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/videos")
      .set("Cookie", user.cookie)
      .attach("video", videoBytes(), { filename: "clip.mp4", contentType: "video/mp4" })
      .field("title", "A real upload")
      .field("category", "Music");

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("processing");

    const [row] = await db.select().from(video).where(eq(video.id, res.body.videoId));
    expect(row?.title).toBe("A real upload");
    expect(row?.isPublished).toBe(false);
  });

  describe("the guards that used to answer HTML 500s", () => {
    it("accepts a thumbnail larger than busboy's 1MB field default", async () => {
      // Regression: any image over ~750KB became a 500 and lost the upload,
      // because the thumbnail travels as a base64 *field*, not a file.
      const user = await createUser();
      const res = await request(app)
        .post("/api/videos")
        .set("Cookie", user.cookie)
        .attach("video", videoBytes(), { filename: "clip.mp4", contentType: "video/mp4" })
        .field("title", "Big thumbnail")
        .field("thumbnailUrl", dataUrl(4096));

      expect(res.status).toBe(202);
    });

    it("answers 413 JSON, not HTML, for a genuinely oversized thumbnail", async () => {
      const user = await createUser();
      const res = await request(app)
        .post("/api/videos")
        .set("Cookie", user.cookie)
        .attach("video", videoBytes(), { filename: "clip.mp4", contentType: "video/mp4" })
        .field("title", "Far too big")
        .field("thumbnailUrl", dataUrl(20 * 1024));

      expect(res.status).toBe(413);
      expect(res.type).toBe("application/json");
      expect(res.body.message).toMatch(/thumbnail/i);
    });

    it("answers 400 JSON for a non-video file", async () => {
      const user = await createUser();
      const res = await request(app)
        .post("/api/videos")
        .set("Cookie", user.cookie)
        .attach("video", Buffer.alloc(64), { filename: "doc.pdf", contentType: "application/pdf" })
        .field("title", "Not a video");

      expect(res.status).toBe(400);
      expect(res.type).toBe("application/json");
    });

    it("rejects an image posted on the video field", async () => {
      // Used to be accepted, stored, queued, and only fail at ffprobe.
      const user = await createUser();
      const res = await request(app)
        .post("/api/videos")
        .set("Cookie", user.cookie)
        .attach("video", Buffer.alloc(64), { filename: "photo.png", contentType: "image/png" })
        .field("title", "An image");

      expect(res.status).toBe(400);
      expect(await db.select().from(video)).toHaveLength(0);
    });
  });
});
