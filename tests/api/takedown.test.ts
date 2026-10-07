import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser, createVideo } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { notification, user, video } from "../../src/db/Schema.js";

const makeAdmin = (id: string) =>
  db.update(user).set({ role: "admin" }).where(eq(user.id, id));

const adminUser = async () => {
  const admin = await createUser("Moderator");
  await makeAdmin(admin.id);
  return admin;
};

describe("GET /api/admin/videos", () => {
  it("is admins only", async () => {
    const viewer = await createUser();
    expect((await request(app).get("/api/admin/videos")).status).toBe(401);
    expect(
      (await request(app).get("/api/admin/videos").set("Cookie", viewer.cookie)).status,
    ).toBe(403);
  });

  it("shows every video, not only reported ones", async () => {
    const admin = await adminUser();
    const creator = await createUser("Ada");
    await createVideo(creator.id, { title: "Nobody flagged this" });

    const res = await request(app).get("/api/admin/videos").set("Cookie", admin.cookie);

    // Proactive review is the point: waiting for a report means the content was
    // already seen by viewers.
    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0]).toMatchObject({
      title: "Nobody flagged this",
      reportCount: 0,
    });
    expect(res.body.videos[0].creator.name).toBe("Ada");
  });

  it("searches by title or by who uploaded it", async () => {
    const admin = await adminUser();
    const creator = await createUser("Findable Person");
    await createVideo(creator.id, { title: "Ordinary title" });

    const byTitle = await request(app)
      .get("/api/admin/videos?q=Ordinary")
      .set("Cookie", admin.cookie);
    const byUploader = await request(app)
      .get("/api/admin/videos?q=Findable")
      .set("Cookie", admin.cookie);

    expect(byTitle.body.videos).toHaveLength(1);
    expect(byUploader.body.videos).toHaveLength(1);
  });

  it("filters to what has been taken down", async () => {
    const admin = await adminUser();
    const creator = await createUser();
    const kept = await createVideo(creator.id, { title: "Fine" });
    const removed = await createVideo(creator.id, { title: "Not fine" });

    await request(app)
      .post(`/api/admin/videos/${removed.id}/takedown`)
      .set("Cookie", admin.cookie)
      .send({ reason: "Adult content" });

    const res = await request(app)
      .get("/api/admin/videos?filter=takendown")
      .set("Cookie", admin.cookie);

    expect(res.body.videos.map((v: { title: string }) => v.title)).toEqual([
      "Not fine",
    ]);
    expect(kept.id).toBeTruthy();
  });
});

describe("taking a video down", () => {
  it("unpublishes it and records why", async () => {
    const admin = await adminUser();
    const creator = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .post(`/api/admin/videos/${row.id}/takedown`)
      .set("Cookie", admin.cookie)
      .send({ reason: "Adult content, no age gate" });

    expect(res.status).toBe(200);

    const [saved] = await db.select().from(video).where(eq(video.id, row.id));
    expect(saved?.isPublished).toBe(false);
    expect(saved?.takedownReason).toBe("Adult content, no age gate");
    expect(saved?.takedownAt).toBeTruthy();
  });

  it("drops it out of the public feed immediately", async () => {
    const admin = await adminUser();
    const creator = await createUser();
    const row = await createVideo(creator.id, { title: "Offensive" });

    expect((await request(app).get("/api/videos")).body.data).toHaveLength(1);

    await request(app)
      .post(`/api/admin/videos/${row.id}/takedown`)
      .set("Cookie", admin.cookie)
      .send({ reason: "Abuse" });

    expect((await request(app).get("/api/videos")).body.data).toHaveLength(0);
    expect((await request(app).get(`/api/videos/${row.id}`)).status).toBe(404);
  });

  it("tells the creator, with no admin named", async () => {
    const admin = await adminUser();
    const creator = await createUser();
    const row = await createVideo(creator.id);

    await request(app)
      .post(`/api/admin/videos/${row.id}/takedown`)
      .set("Cookie", admin.cookie)
      .send({ reason: "Abuse" });

    const res = await request(app)
      .get("/api/notifications")
      .set("Cookie", creator.cookie);

    expect(res.body.notifications[0]).toMatchObject({ type: "video_takedown" });
    // A moderation decision speaks for the platform; naming the admin invites
    // retaliation.
    expect(res.body.notifications[0].actor).toBeNull();
    expect(await db.select().from(notification)).toHaveLength(1);
  });

  it("requires a reason", async () => {
    const admin = await adminUser();
    const creator = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .post(`/api/admin/videos/${row.id}/takedown`)
      .set("Cookie", admin.cookie)
      .send({ reason: "   " });

    expect(res.status).toBe(400);
  });

  it("stops the creator simply publishing it again", async () => {
    const admin = await adminUser();
    const creator = await createUser();
    const row = await createVideo(creator.id);

    await request(app)
      .post(`/api/admin/videos/${row.id}/takedown`)
      .set("Cookie", admin.cookie)
      .send({ reason: "Abuse" });

    const res = await request(app)
      .patch(`/api/videos/${row.id}`)
      .set("Cookie", creator.cookie)
      .send({ isPublished: true });

    // Otherwise a takedown is a one-click inconvenience.
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/moderator/i);
  });

  it("is refused for anyone who is not an admin", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const row = await createVideo(creator.id);

    expect(
      (
        await request(app)
          .post(`/api/admin/videos/${row.id}/takedown`)
          .set("Cookie", stranger.cookie)
          .send({ reason: "I dislike it" })
      ).status,
    ).toBe(403);
    // Not even the creator can take down their own, which would muddle the
    // meaning of the flag.
    expect(
      (
        await request(app)
          .post(`/api/admin/videos/${row.id}/takedown`)
          .set("Cookie", creator.cookie)
          .send({ reason: "mine" })
      ).status,
    ).toBe(403);
  });
});

describe("restoring", () => {
  it("lifts the block without republishing", async () => {
    const admin = await adminUser();
    const creator = await createUser();
    const row = await createVideo(creator.id);

    await request(app)
      .post(`/api/admin/videos/${row.id}/takedown`)
      .set("Cookie", admin.cookie)
      .send({ reason: "Mistaken" });

    const res = await request(app)
      .post(`/api/admin/videos/${row.id}/restore`)
      .set("Cookie", admin.cookie);

    expect(res.status).toBe(200);

    const [saved] = await db.select().from(video).where(eq(video.id, row.id));
    expect(saved?.takedownReason).toBeNull();
    // Whether it goes back up is the creator's call, not the moderator's.
    expect(saved?.isPublished).toBe(false);

    const republish = await request(app)
      .patch(`/api/videos/${row.id}`)
      .set("Cookie", creator.cookie)
      .send({ isPublished: true });
    expect(republish.status).toBe(200);
  });
});

describe("deleting someone else's video", () => {
  it("is allowed for an admin", async () => {
    const admin = await adminUser();
    const creator = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .delete(`/api/videos/${row.id}`)
      .set("Cookie", admin.cookie);

    expect(res.status).toBe(200);
    expect(await db.select().from(video).where(eq(video.id, row.id))).toHaveLength(0);
  });

  it("is still refused for everyone else", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .delete(`/api/videos/${row.id}`)
      .set("Cookie", stranger.cookie);

    expect(res.status).toBe(403);
  });
});

describe("acting on a report about a video", () => {
  const reportVideo = async (reporter: { cookie: string }, videoId: string) => {
    await request(app)
      .post("/api/reports")
      .set("Cookie", reporter.cookie)
      .send({ reason: "sexual", videoId, details: "18+ content" });

    const admin = await adminUser();
    const queue = await request(app).get("/api/reports").set("Cookie", admin.cookie);
    return { admin, reportId: queue.body.reports[0].id as string };
  };

  it("lets an admin take the video down from the queue", async () => {
    const creator = await createUser();
    const reporter = await createUser();
    const row = await createVideo(creator.id);
    const { admin, reportId } = await reportVideo(reporter, row.id);

    const res = await request(app)
      .post(`/api/reports/${reportId}/resolve`)
      .set("Cookie", admin.cookie)
      .send({ action: "takedown", reason: "Sexual content" });

    expect(res.body.status).toBe("actioned");

    const [saved] = await db.select().from(video).where(eq(video.id, row.id));
    expect(saved?.isPublished).toBe(false);
    expect(saved?.takedownReason).toBe("Sexual content");
  });

  it("lets an admin delete it outright", async () => {
    const creator = await createUser();
    const reporter = await createUser();
    const row = await createVideo(creator.id);
    const { admin, reportId } = await reportVideo(reporter, row.id);

    await request(app)
      .post(`/api/reports/${reportId}/resolve`)
      .set("Cookie", admin.cookie)
      .send({ action: "delete" });

    expect(await db.select().from(video).where(eq(video.id, row.id))).toHaveLength(0);
  });

  it("refuses the video's own creator", async () => {
    const creator = await createUser();
    const reporter = await createUser();
    const row = await createVideo(creator.id);
    const { reportId } = await reportVideo(reporter, row.id);

    const res = await request(app)
      .post(`/api/reports/${reportId}/resolve`)
      .set("Cookie", creator.cookie)
      .send({ action: "dismiss" });

    // Judging a complaint about your own video was never your call.
    expect(res.status).toBe(403);
  });
});
