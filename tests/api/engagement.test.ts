import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, createUser, createVideo, createVideos } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { like, subscriber } from "../../src/db/Schema.js";

describe("likes", () => {
  it("requires a session", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    expect((await request(app).post(`/api/videos/${row.id}/like`)).status).toBe(401);
  });

  it("counts one like per person however many times they click", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    const first = await request(app)
      .post(`/api/videos/${row.id}/like`)
      .set("Cookie", fan.cookie);
    const second = await request(app)
      .post(`/api/videos/${row.id}/like`)
      .set("Cookie", fan.cookie);

    expect(first.body).toEqual({ liked: true, likeCount: 1 });
    // The unique index makes the repeat a no-op rather than a second row.
    expect(second.body).toEqual({ liked: true, likeCount: 1 });
    expect(await db.select().from(like)).toHaveLength(1);
  });

  it("adds up across different people", async () => {
    const creator = await createUser();
    const a = await createUser();
    const b = await createUser();
    const row = await createVideo(creator.id);

    await request(app).post(`/api/videos/${row.id}/like`).set("Cookie", a.cookie);
    const res = await request(app)
      .post(`/api/videos/${row.id}/like`)
      .set("Cookie", b.cookie);

    expect(res.body.likeCount).toBe(2);
  });

  it("treats unliking something never liked as success", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .delete(`/api/videos/${row.id}/like`)
      .set("Cookie", fan.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liked: false, likeCount: 0 });
  });

  it("refuses a like on a video the viewer cannot see", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const draft = await createVideo(creator.id, { isPublished: false });

    const res = await request(app)
      .post(`/api/videos/${draft.id}/like`)
      .set("Cookie", stranger.cookie);

    expect(res.status).toBe(404);
  });

  it("reports isLiked on the video detail for the viewer who liked it", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);
    await request(app).post(`/api/videos/${row.id}/like`).set("Cookie", fan.cookie);

    const forFan = await request(app)
      .get(`/api/videos/${row.id}`)
      .set("Cookie", fan.cookie);
    const forAnyone = await request(app).get(`/api/videos/${row.id}`);

    expect(forFan.body.engagement).toEqual({
      likeCount: 1,
      commentCount: 0,
      isLiked: true,
    });
    expect(forAnyone.body.engagement.isLiked).toBe(false);
  });
});

describe("comments", () => {
  it("rejects an empty comment", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", creator.cookie)
      .send({ message: "   " });

    expect(res.status).toBe(400);
  });

  it("posts a comment and lists it newest-first", async () => {
    const creator = await createUser("Ada");
    const row = await createVideo(creator.id);

    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", creator.cookie)
      .send({ message: "First" });
    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", creator.cookie)
      .send({ message: "Second" });

    const res = await request(app).get(`/api/videos/${row.id}/comments`);

    expect(res.body.comments.map((c: { message: string }) => c.message)).toEqual([
      "Second",
      "First",
    ]);
    expect(res.body.comments[0].author.name).toBe("Ada");
  });

  it("nests a reply under its parent", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    const parent = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Nice one" });

    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", creator.cookie)
      .send({ message: "Thanks!", parentCommentId: parent.body.comment.id });

    const res = await request(app).get(`/api/videos/${row.id}/comments`);

    expect(res.body.comments).toHaveLength(1);
    expect(res.body.comments[0].replies).toHaveLength(1);
    expect(res.body.comments[0].replies[0].message).toBe("Thanks!");
  });

  it("flattens a reply to a reply onto the thread it belongs to", async () => {
    // Threads stay one level deep so the UI never needs a recursive renderer.
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    const parent = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Top level" });
    const reply = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", creator.cookie)
      .send({ message: "A reply", parentCommentId: parent.body.comment.id });
    const nested = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Reply to the reply", parentCommentId: reply.body.comment.id });

    expect(nested.body.comment.parentCommentId).toBe(parent.body.comment.id);

    const res = await request(app).get(`/api/videos/${row.id}/comments`);
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.comments[0].replies).toHaveLength(2);
  });

  it("lets the author delete their own comment", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);
    const posted = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Mine" });

    const res = await request(app)
      .delete(`/api/comments/${posted.body.comment.id}`)
      .set("Cookie", fan.cookie);

    expect(res.status).toBe(200);
  });

  it("lets the video's creator moderate someone else's comment", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);
    const posted = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Spam" });

    const res = await request(app)
      .delete(`/api/comments/${posted.body.comment.id}`)
      .set("Cookie", creator.cookie);

    expect(res.status).toBe(200);
  });

  it("refuses deletion by an unrelated viewer", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const stranger = await createUser();
    const row = await createVideo(creator.id);
    const posted = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Not yours" });

    const res = await request(app)
      .delete(`/api/comments/${posted.body.comment.id}`)
      .set("Cookie", stranger.cookie);

    expect(res.status).toBe(403);
  });

  it("takes the replies with a deleted parent", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    const parent = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", creator.cookie)
      .send({ message: "Parent" });
    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", creator.cookie)
      .send({ message: "Child", parentCommentId: parent.body.comment.id });

    await request(app)
      .delete(`/api/comments/${parent.body.comment.id}`)
      .set("Cookie", creator.cookie);

    const res = await request(app).get(`/api/videos/${row.id}/comments`);
    expect(res.body.comments).toHaveLength(0);
    // The reply went with it rather than being orphaned.
    const detail = await request(app).get(`/api/videos/${row.id}`);
    expect(detail.body.engagement.commentCount).toBe(0);
  });
});

describe("subscriptions", () => {
  it("refuses subscribing to yourself", async () => {
    const creator = await createUser();

    const res = await request(app)
      .post(`/api/creators/${creator.id}/subscribe`)
      .set("Cookie", creator.cookie);

    expect(res.status).toBe(400);
  });

  it("counts one subscription however many times they click", async () => {
    const creator = await createUser();
    const fan = await createUser();

    await request(app)
      .post(`/api/creators/${creator.id}/subscribe`)
      .set("Cookie", fan.cookie);
    const second = await request(app)
      .post(`/api/creators/${creator.id}/subscribe`)
      .set("Cookie", fan.cookie);

    expect(second.body).toEqual({ subscribed: true, subscriberCount: 1 });
    expect(await db.select().from(subscriber)).toHaveLength(1);
  });

  it("unsubscribes back to zero", async () => {
    const creator = await createUser();
    const fan = await createUser();

    await request(app)
      .post(`/api/creators/${creator.id}/subscribe`)
      .set("Cookie", fan.cookie);
    const res = await request(app)
      .delete(`/api/creators/${creator.id}/subscribe`)
      .set("Cookie", fan.cookie);

    expect(res.body).toEqual({ subscribed: false, subscriberCount: 0 });
  });

  it("shows a creator profile with only their published videos", async () => {
    const creator = await createUser("Ada");
    await createVideos(creator.id, [
      { title: "Published" },
      { title: "Draft", isPublished: false },
    ]);

    const res = await request(app).get(`/api/creators/${creator.id}`);

    expect(res.status).toBe(200);
    expect(res.body.creator).toMatchObject({ name: "Ada", videoCount: 1 });
    expect(res.body.videos.map((v: { title: string }) => v.title)).toEqual([
      "Published",
    ]);
  });
});

describe("the following feed", () => {
  it("needs a session", async () => {
    expect((await request(app).get("/api/videos?following=true")).status).toBe(401);
  });

  it("returns only videos from creators the viewer subscribes to", async () => {
    const followed = await createUser("Followed");
    const ignored = await createUser("Ignored");
    const fan = await createUser();
    await createVideo(followed.id, { title: "From someone I follow" });
    await createVideo(ignored.id, { title: "From a stranger" });

    await request(app)
      .post(`/api/creators/${followed.id}/subscribe`)
      .set("Cookie", fan.cookie);

    const res = await request(app)
      .get("/api/videos?following=true")
      .set("Cookie", fan.cookie);

    expect(res.body.data.map((v: { title: string }) => v.title)).toEqual([
      "From someone I follow",
    ]);
  });

  it("is empty before subscribing to anyone", async () => {
    const creator = await createUser();
    const fan = await createUser();
    await createVideo(creator.id);

    const res = await request(app)
      .get("/api/videos?following=true")
      .set("Cookie", fan.cookie);

    expect(res.body.data).toEqual([]);
  });
});

describe("view counting", () => {
  it("increments only for a published video", async () => {
    const creator = await createUser();
    const published = await createVideo(creator.id);
    const draft = await createVideo(creator.id, { isPublished: false });

    const first = await request(app).post(`/api/videos/${published.id}/view`);
    const second = await request(app).post(`/api/videos/${published.id}/view`);
    const onDraft = await request(app).post(`/api/videos/${draft.id}/view`);

    expect(first.body.viewCount).toBe(1);
    expect(second.body.viewCount).toBe(2);
    expect(onDraft.status).toBe(409);
  });
});
