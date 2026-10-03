import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser, createVideo, createVideos } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { video, videoRendition } from "../../src/db/Schema.js";

const titles = (res: request.Response): string[] =>
  (res.body.data ?? res.body.videos ?? []).map((v: { title: string }) => v.title);

describe("GET /api/videos", () => {
  it("shows only published, ready videos", async () => {
    const user = await createUser();
    await createVideos(user.id, [
      { title: "Public" },
      { title: "Draft", isPublished: false },
      { title: "Still transcoding", status: "processing" },
      { title: "Failed", status: "failed" },
    ]);

    const res = await request(app).get("/api/videos");

    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(["Public"]);
  });

  it("paginates newest-first and stops cleanly at the end", async () => {
    const user = await createUser();
    await createVideos(user.id, [
      { title: "First" },
      { title: "Second" },
      { title: "Third" },
    ]);

    const page1 = await request(app).get("/api/videos?limit=2");
    expect(titles(page1)).toEqual(["Third", "Second"]);
    expect(page1.body.meta.nextCursor).toBeTruthy();

    const page2 = await request(app).get(
      `/api/videos?limit=2&cursor=${page1.body.meta.nextCursor}`,
    );
    expect(titles(page2)).toEqual(["First"]);
    // Regression: a short page used to hand back a cursor to nowhere.
    expect(page2.body.meta.nextCursor).toBeNull();
  });

  describe("search", () => {
    it("matches title, description and tags as one document", async () => {
      const user = await createUser();
      await createVideos(user.id, [
        { title: "Rocket launch", description: "A night launch", tags: "space" },
        { title: "Ramen at home", description: "Tonkotsu broth", tags: "cooking" },
      ]);

      expect(titles(await request(app).get("/api/videos?q=rocket"))).toEqual([
        "Rocket launch",
      ]);
      expect(titles(await request(app).get("/api/videos?q=tonkotsu"))).toEqual([
        "Ramen at home",
      ]);
      expect(titles(await request(app).get("/api/videos?q=space"))).toEqual([
        "Rocket launch",
      ]);
    });

    it("stems, so a search word need not match exactly", async () => {
      const user = await createUser();
      await createVideo(user.id, { title: "Learning to rock climb" });

      expect(titles(await request(app).get("/api/videos?q=climbing"))).toEqual([
        "Learning to rock climb",
      ]);
    });

    it("returns nothing rather than everything for an unmatched query", async () => {
      const user = await createUser();
      await createVideo(user.id, { title: "Anything" });

      expect(titles(await request(app).get("/api/videos?q=zzzznomatch"))).toEqual([]);
    });
  });

  describe("filters", () => {
    it("matches a category case-insensitively", async () => {
      const user = await createUser();
      await createVideos(user.id, [
        { title: "A song", category: "Music" },
        { title: "A match", category: "Sport" },
      ]);

      expect(titles(await request(app).get("/api/videos?category=music"))).toEqual([
        "A song",
      ]);
    });

    it("matches a whole tag, not a substring of one", async () => {
      // A search for "rock" must not pull in a video tagged "rocket".
      const user = await createUser();
      await createVideos(user.id, [
        { title: "Climbing", tags: "rock, outdoors" },
        { title: "Space", tags: "rocket, night" },
      ]);

      expect(titles(await request(app).get("/api/videos?tag=rock"))).toEqual([
        "Climbing",
      ]);
    });

    it("ignores spacing in a tag list", async () => {
      const user = await createUser();
      await createVideo(user.id, { title: "Spaced", tags: "lo fi,  chill  , study" });

      expect(titles(await request(app).get("/api/videos?tag=chill"))).toEqual([
        "Spaced",
      ]);
    });
  });
});

describe("GET /api/videos/:id", () => {
  it("returns the video with its creator and engagement counts", async () => {
    const creator = await createUser("Ada");
    const row = await createVideo(creator.id, { title: "Detail" });

    const res = await request(app).get(`/api/videos/${row.id}`);

    expect(res.status).toBe(200);
    expect(res.body.video.title).toBe("Detail");
    expect(res.body.creator).toMatchObject({
      name: "Ada",
      subscriberCount: 0,
      isSubscribed: false,
    });
    expect(res.body.engagement).toEqual({
      likeCount: 0,
      commentCount: 0,
      isLiked: false,
    });
  });

  it("hides someone else's draft behind a 404", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const row = await createVideo(creator.id, { isPublished: false });

    expect((await request(app).get(`/api/videos/${row.id}`)).status).toBe(404);
    expect(
      (await request(app).get(`/api/videos/${row.id}`).set("Cookie", stranger.cookie))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/videos/${row.id}`).set("Cookie", creator.cookie))
        .status,
    ).toBe(200);
  });
});

describe("GET /api/videos/:id/status", () => {
  it("gives the raw transcoding error only to the creator", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, {
      status: "failed",
      isPublished: false,
      processingError: "ffprobe exited: E:/Strreamhub/tmp/uploads/x.mp4 invalid data",
    });

    const asCreator = await request(app)
      .get(`/api/videos/${row.id}/status`)
      .set("Cookie", creator.cookie);
    const asStranger = await request(app).get(`/api/videos/${row.id}/status`);

    expect(asCreator.body.error).toMatch(/ffprobe/);
    // A server path must never reach a stranger.
    expect(asStranger.body.error).not.toMatch(/Strreamhub|ffprobe/);
    expect(asStranger.body.error).toBeTruthy();
  });
});

describe("PATCH /api/videos/:id", () => {
  it("edits only the fields supplied", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, {
      title: "Before",
      description: "Keep me",
    });

    const res = await request(app)
      .patch(`/api/videos/${row.id}`)
      .set("Cookie", creator.cookie)
      .send({ title: "After" });

    expect(res.status).toBe(200);
    expect(res.body.video.title).toBe("After");
    expect(res.body.video.description).toBe("Keep me");
  });

  it("refuses to publish a video that is not ready", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, {
      status: "processing",
      isPublished: false,
    });

    const res = await request(app)
      .patch(`/api/videos/${row.id}`)
      .set("Cookie", creator.cookie)
      .send({ isPublished: true });

    expect(res.status).toBe(409);
  });

  it("refuses an edit by anyone but the creator", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .patch(`/api/videos/${row.id}`)
      .set("Cookie", stranger.cookie)
      .send({ title: "Mine now" });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/videos/:id", () => {
  it("removes the video and its renditions", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    await db.insert(videoRendition).values({
      videoId: row.id,
      name: "360p",
      height: 360,
      bandwidth: 896000,
      playlistUrl: "https://res.cloudinary.test/raw/upload/360p/index.m3u8",
      segmentCount: 3,
    });

    const res = await request(app)
      .delete(`/api/videos/${row.id}`)
      .set("Cookie", creator.cookie);

    expect(res.status).toBe(200);
    expect(await db.select().from(video).where(eq(video.id, row.id))).toHaveLength(0);
    // Renditions go with it through the cascade.
    expect(
      await db.select().from(videoRendition).where(eq(videoRendition.videoId, row.id)),
    ).toHaveLength(0);
  });

  it("refuses a delete by anyone but the creator", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .delete(`/api/videos/${row.id}`)
      .set("Cookie", stranger.cookie);

    expect(res.status).toBe(403);
    expect(await db.select().from(video).where(eq(video.id, row.id))).toHaveLength(1);
  });
});
