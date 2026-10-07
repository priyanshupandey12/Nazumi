import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser, createVideo } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { video, videoThumbnail } from "../../src/db/Schema.js";

const CANDIDATES = [
  "https://res.cloudinary.test/image/upload/videos/x/thumbs/0.jpg",
  "https://res.cloudinary.test/image/upload/videos/x/thumbs/1.jpg",
  "https://res.cloudinary.test/image/upload/videos/x/thumbs/2.jpg",
];

const seedCandidates = (videoId: string) =>
  db.insert(videoThumbnail).values(
    CANDIDATES.map((url, position) => ({ videoId, url, position })),
  );

describe("GET /api/videos/:id/thumbnails", () => {
  it("needs a session", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    expect((await request(app).get(`/api/videos/${row.id}/thumbnails`)).status).toBe(401);
  });

  it("is hidden from everyone but the creator", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const row = await createVideo(creator.id);
    await seedCandidates(row.id);

    const res = await request(app)
      .get(`/api/videos/${row.id}/thumbnails`)
      .set("Cookie", stranger.cookie);

    // Frames from an unpublished cut are not public.
    expect(res.status).toBe(404);
  });

  it("returns the candidates in timeline order with the current pick", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, { thumbnailUrl: CANDIDATES[1] });
    await seedCandidates(row.id);

    const res = await request(app)
      .get(`/api/videos/${row.id}/thumbnails`)
      .set("Cookie", creator.cookie);

    expect(res.status).toBe(200);
    expect(res.body.thumbnails.map((t: { position: number }) => t.position)).toEqual([
      0, 1, 2,
    ]);
    expect(res.body.selected).toBe(CANDIDATES[1]);
  });

  it("is simply empty for a video with no frames yet", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, { status: "processing" });

    const res = await request(app)
      .get(`/api/videos/${row.id}/thumbnails`)
      .set("Cookie", creator.cookie);

    expect(res.body.thumbnails).toEqual([]);
  });
});

describe("choosing a generated frame", () => {
  it("accepts one of the video's own candidates", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, { thumbnailUrl: null });
    await seedCandidates(row.id);

    const res = await request(app)
      .patch(`/api/videos/${row.id}`)
      .set("Cookie", creator.cookie)
      .send({ thumbnailUrl: CANDIDATES[2] });

    expect(res.status).toBe(200);
    expect(res.body.video.thumbnailUrl).toBe(CANDIDATES[2]);
  });

  it("refuses a URL that is not a candidate of this video", async () => {
    const creator = await createUser();
    const mine = await createVideo(creator.id, { thumbnailUrl: null });
    await seedCandidates(mine.id);

    const res = await request(app)
      .patch(`/api/videos/${mine.id}`)
      .set("Cookie", creator.cookie)
      .send({ thumbnailUrl: "https://elsewhere.test/anything.jpg" });

    // Otherwise any URL could be planted as a thumbnail.
    expect(res.status).toBe(400);
    const [saved] = await db.select().from(video).where(eq(video.id, mine.id));
    expect(saved?.thumbnailUrl).toBeNull();
  });

  it("refuses another video's candidate", async () => {
    const creator = await createUser();
    const mine = await createVideo(creator.id, { thumbnailUrl: null });
    const theirs = await createVideo(creator.id);
    await seedCandidates(theirs.id);

    const res = await request(app)
      .patch(`/api/videos/${mine.id}`)
      .set("Cookie", creator.cookie)
      .send({ thumbnailUrl: CANDIDATES[0] });

    expect(res.status).toBe(400);
    const [saved] = await db.select().from(video).where(eq(video.id, mine.id));
    expect(saved?.thumbnailUrl).toBeNull();
  });

  it("keeps the candidate available after switching away from it", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, { thumbnailUrl: CANDIDATES[0] });
    await seedCandidates(row.id);

    await request(app)
      .patch(`/api/videos/${row.id}`)
      .set("Cookie", creator.cookie)
      .send({ thumbnailUrl: CANDIDATES[1] });

    // A generated frame must survive being deselected — only a creator's own
    // upload is destroyed when replaced.
    const res = await request(app)
      .get(`/api/videos/${row.id}/thumbnails`)
      .set("Cookie", creator.cookie);
    expect(res.body.thumbnails).toHaveLength(3);
    expect(res.body.selected).toBe(CANDIDATES[1]);
  });

  it("still accepts an uploaded image", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, { thumbnailUrl: null });
    await seedCandidates(row.id);

    const res = await request(app)
      .patch(`/api/videos/${row.id}`)
      .set("Cookie", creator.cookie)
      .send({ thumbnailUrl: "data:image/png;base64,AAAA" });

    expect(res.body.video.thumbnailUrl).toMatch(/^https:\/\/res\.cloudinary\.test\//);
  });
});

describe("deleting a video", () => {
  it("takes its generated frames with it", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    await seedCandidates(row.id);

    await request(app).delete(`/api/videos/${row.id}`).set("Cookie", creator.cookie);

    expect(await db.select().from(video).where(eq(video.id, row.id))).toHaveLength(0);
    expect(
      await db.select().from(videoThumbnail).where(eq(videoThumbnail.videoId, row.id)),
    ).toHaveLength(0);
  });
});
