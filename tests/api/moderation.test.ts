import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser, createVideo } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { comment, report, user } from "../../src/db/Schema.js";

const makeAdmin = (id: string) =>
  db.update(user).set({ role: "admin" }).where(eq(user.id, id));

const postComment = async (
  author: { cookie: string },
  videoId: string,
  message = "something rude",
) => {
  const res = await request(app)
    .post(`/api/videos/${videoId}/comments`)
    .set("Cookie", author.cookie)
    .send({ message });
  return res.body.comment.id as string;
};

describe("POST /api/reports", () => {
  it("needs a session", async () => {
    expect((await request(app).post("/api/reports").send({})).status).toBe(401);
  });

  it("requires a reason", async () => {
    const creator = await createUser();
    const viewer = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .post("/api/reports")
      .set("Cookie", viewer.cookie)
      .send({ videoId: row.id });

    expect(res.status).toBe(400);
  });

  it("requires exactly one target", async () => {
    const creator = await createUser();
    const viewer = await createUser();
    const row = await createVideo(creator.id);
    const commentId = await postComment(viewer, row.id);

    const neither = await request(app)
      .post("/api/reports")
      .set("Cookie", viewer.cookie)
      .send({ reason: "spam" });
    const both = await request(app)
      .post("/api/reports")
      .set("Cookie", viewer.cookie)
      .send({ reason: "spam", videoId: row.id, commentId });

    expect(neither.status).toBe(400);
    expect(both.status).toBe(400);
  });

  it("records a report against a video", async () => {
    const creator = await createUser();
    const viewer = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .post("/api/reports")
      .set("Cookie", viewer.cookie)
      .send({ reason: "spam", videoId: row.id, details: "Reposted content" });

    expect(res.status).toBe(201);
    const [saved] = await db.select().from(report);
    expect(saved).toMatchObject({ reason: "spam", status: "open" });
  });

  it("counts a repeat report once", async () => {
    const creator = await createUser();
    const viewer = await createUser();
    const row = await createVideo(creator.id);

    const send = () =>
      request(app)
        .post("/api/reports")
        .set("Cookie", viewer.cookie)
        .send({ reason: "spam", videoId: row.id });

    await send();
    const second = await send();

    // Re-reporting should not inflate a queue someone works through by hand.
    expect(second.status).toBe(201);
    expect(await db.select().from(report)).toHaveLength(1);
  });

  it("refuses a report of your own video or comment", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    const own = await postComment(creator, row.id);

    const video = await request(app)
      .post("/api/reports")
      .set("Cookie", creator.cookie)
      .send({ reason: "spam", videoId: row.id });
    const comment = await request(app)
      .post("/api/reports")
      .set("Cookie", creator.cookie)
      .send({ reason: "spam", commentId: own });

    expect(video.status).toBe(400);
    expect(comment.status).toBe(400);
  });

  it("404s for a draft, which the public cannot see", async () => {
    const creator = await createUser();
    const viewer = await createUser();
    const draft = await createVideo(creator.id, { isPublished: false });

    const res = await request(app)
      .post("/api/reports")
      .set("Cookie", viewer.cookie)
      .send({ reason: "spam", videoId: draft.id });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/reports", () => {
  it("shows a creator reports on comments under their own videos", async () => {
    const creator = await createUser();
    const rude = await createUser();
    const reporter = await createUser();
    const row = await createVideo(creator.id);
    const commentId = await postComment(rude, row.id);

    await request(app)
      .post("/api/reports")
      .set("Cookie", reporter.cookie)
      .send({ reason: "harassment", commentId });

    const res = await request(app).get("/api/reports").set("Cookie", creator.cookie);

    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0]).toMatchObject({
      reason: "harassment",
      comment: { message: "something rude" },
    });
    expect(res.body.isAdmin).toBe(false);
  });

  it("does not show a creator reports on someone else's video", async () => {
    const creator = await createUser();
    const other = await createUser();
    const reporter = await createUser();
    const theirs = await createVideo(other.id);
    const commentId = await postComment(reporter, theirs.id);

    await request(app)
      .post("/api/reports")
      .set("Cookie", creator.cookie)
      .send({ reason: "spam", commentId });

    const res = await request(app).get("/api/reports").set("Cookie", creator.cookie);

    expect(res.body.reports).toHaveLength(0);
  });

  it("does not show a creator reports about a video, only about comments", async () => {
    const creator = await createUser();
    const reporter = await createUser();
    const row = await createVideo(creator.id);

    await request(app)
      .post("/api/reports")
      .set("Cookie", reporter.cookie)
      .send({ reason: "spam", videoId: row.id });

    // Judging a complaint about their own video is not the creator's call.
    const res = await request(app).get("/api/reports").set("Cookie", creator.cookie);
    expect(res.body.reports).toHaveLength(0);
  });

  it("shows an admin everything, including video reports", async () => {
    const creator = await createUser();
    const reporter = await createUser();
    const admin = await createUser();
    await makeAdmin(admin.id);
    const row = await createVideo(creator.id);
    const commentId = await postComment(reporter, row.id);

    await request(app)
      .post("/api/reports")
      .set("Cookie", reporter.cookie)
      .send({ reason: "spam", videoId: row.id });
    await request(app)
      .post("/api/reports")
      .set("Cookie", creator.cookie)
      .send({ reason: "harassment", commentId });

    const res = await request(app).get("/api/reports").set("Cookie", admin.cookie);

    expect(res.body.isAdmin).toBe(true);
    expect(res.body.reports).toHaveLength(2);
  });
});

describe("POST /api/reports/:id/resolve", () => {
  const seed = async () => {
    const creator = await createUser();
    const rude = await createUser();
    const reporter = await createUser();
    const row = await createVideo(creator.id);
    const commentId = await postComment(rude, row.id);

    await request(app)
      .post("/api/reports")
      .set("Cookie", reporter.cookie)
      .send({ reason: "harassment", commentId });

    const queue = await request(app).get("/api/reports").set("Cookie", creator.cookie);
    return { creator, reporter, commentId, reportId: queue.body.reports[0].id as string };
  };

  it("dismisses a report, leaving the comment alone", async () => {
    const { creator, commentId, reportId } = await seed();

    const res = await request(app)
      .post(`/api/reports/${reportId}/resolve`)
      .set("Cookie", creator.cookie)
      .send({ action: "dismiss" });

    expect(res.body.status).toBe("dismissed");
    expect(await db.select().from(comment).where(eq(comment.id, commentId))).toHaveLength(1);
    // It leaves the open queue.
    const queue = await request(app).get("/api/reports").set("Cookie", creator.cookie);
    expect(queue.body.reports).toHaveLength(0);
  });

  it("removes the comment and the reports that came with it", async () => {
    const { creator, commentId, reportId } = await seed();

    const res = await request(app)
      .post(`/api/reports/${reportId}/resolve`)
      .set("Cookie", creator.cookie)
      .send({ action: "delete" });

    expect(res.body.status).toBe("actioned");
    expect(await db.select().from(comment).where(eq(comment.id, commentId))).toHaveLength(0);
    expect(await db.select().from(report)).toHaveLength(0);
  });

  it("refuses someone with no claim over the target", async () => {
    const { reporter, reportId } = await seed();

    const res = await request(app)
      .post(`/api/reports/${reportId}/resolve`)
      .set("Cookie", reporter.cookie)
      .send({ action: "delete" });

    expect(res.status).toBe(403);
  });

  it("rejects an unknown action", async () => {
    const { creator, reportId } = await seed();

    const res = await request(app)
      .post(`/api/reports/${reportId}/resolve`)
      .set("Cookie", creator.cookie)
      .send({ action: "ban" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/reports/open-count", () => {
  it("counts only what this creator has to deal with", async () => {
    const creator = await createUser();
    const other = await createUser();
    const reporter = await createUser();

    const mine = await createVideo(creator.id);
    const theirs = await createVideo(other.id);

    await request(app)
      .post("/api/reports")
      .set("Cookie", reporter.cookie)
      .send({ reason: "spam", commentId: await postComment(other, mine.id) });
    await request(app)
      .post("/api/reports")
      .set("Cookie", reporter.cookie)
      .send({ reason: "spam", commentId: await postComment(creator, theirs.id) });

    const res = await request(app)
      .get("/api/reports/open-count")
      .set("Cookie", creator.cookie);

    expect(res.body).toEqual({ openCount: 1 });
  });
});
