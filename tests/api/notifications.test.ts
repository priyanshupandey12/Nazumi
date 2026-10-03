import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, createUser, createVideo } from "../helpers.js";

/** Subscribe `fan` to `creator`. */
const follow = (fan: { cookie: string }, creatorId: string) =>
  request(app).post(`/api/creators/${creatorId}/subscribe`).set("Cookie", fan.cookie);

const inboxOf = async (viewer: { cookie: string }) => {
  const res = await request(app).get("/api/notifications").set("Cookie", viewer.cookie);
  return res.body as {
    notifications: Array<{
      id: string;
      type: string;
      isRead: boolean;
      actor: { name: string } | null;
      video: { title: string } | null;
      comment: { message: string } | null;
    }>;
    unreadCount: number;
  };
};

describe("GET /api/notifications", () => {
  it("needs a session", async () => {
    expect((await request(app).get("/api/notifications")).status).toBe(401);
  });

  it("is empty for a new account", async () => {
    const viewer = await createUser();
    const inbox = await inboxOf(viewer);

    expect(inbox.notifications).toEqual([]);
    expect(inbox.unreadCount).toBe(0);
  });

  it("never shows one person another person's notifications", async () => {
    const creator = await createUser("Ada");
    const fan = await createUser("Fan");
    const stranger = await createUser("Stranger");
    await follow(fan, creator.id);

    const draft = await createVideo(creator.id, {
      title: "New upload",
      isPublished: false,
    });
    await request(app)
      .patch(`/api/videos/${draft.id}`)
      .set("Cookie", creator.cookie)
      .send({ isPublished: true });

    expect((await inboxOf(fan)).notifications).toHaveLength(1);
    expect((await inboxOf(stranger)).notifications).toHaveLength(0);
  });
});

describe("publishing a video", () => {
  it("tells every subscriber", async () => {
    const creator = await createUser("Ada");
    const a = await createUser();
    const b = await createUser();
    await follow(a, creator.id);
    await follow(b, creator.id);

    const draft = await createVideo(creator.id, {
      title: "Something new",
      isPublished: false,
    });
    await request(app)
      .patch(`/api/videos/${draft.id}`)
      .set("Cookie", creator.cookie)
      .send({ isPublished: true });

    for (const viewer of [a, b]) {
      const inbox = await inboxOf(viewer);
      expect(inbox.unreadCount).toBe(1);
      expect(inbox.notifications[0]).toMatchObject({
        type: "new_video",
        isRead: false,
        actor: { name: "Ada" },
        video: { title: "Something new" },
      });
    }
  });

  it("does not tell the creator about their own upload", async () => {
    const creator = await createUser();
    // A creator subscribing to themselves is refused, but the fan-out must not
    // rely on that for correctness.
    const draft = await createVideo(creator.id, { isPublished: false });
    await request(app)
      .patch(`/api/videos/${draft.id}`)
      .set("Cookie", creator.cookie)
      .send({ isPublished: true });

    expect((await inboxOf(creator)).notifications).toHaveLength(0);
  });

  it("tells nobody a second time when a video is unpublished and republished", async () => {
    const creator = await createUser();
    const fan = await createUser();
    await follow(fan, creator.id);

    const draft = await createVideo(creator.id, { isPublished: false });
    const publish = () =>
      request(app)
        .patch(`/api/videos/${draft.id}`)
        .set("Cookie", creator.cookie)
        .send({ isPublished: true });

    await publish();
    await request(app)
      .patch(`/api/videos/${draft.id}`)
      .set("Cookie", creator.cookie)
      .send({ isPublished: false });
    await publish();

    // Subscribers would otherwise be pinged again about a video they have
    // already seen, every time the creator toggles visibility.
    expect((await inboxOf(fan)).notifications).toHaveLength(1);
  });

  it("says nothing when an already-public video is merely edited", async () => {
    const creator = await createUser();
    const fan = await createUser();
    await follow(fan, creator.id);
    const published = await createVideo(creator.id, { title: "Live already" });

    await request(app)
      .patch(`/api/videos/${published.id}`)
      .set("Cookie", creator.cookie)
      .send({ title: "Renamed" });

    expect((await inboxOf(fan)).notifications).toHaveLength(0);
  });
});

describe("commenting", () => {
  it("tells the video's creator about a top-level comment", async () => {
    const creator = await createUser("Ada");
    const fan = await createUser("Riya");
    const row = await createVideo(creator.id, { title: "Watch this" });

    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Loved it" });

    const inbox = await inboxOf(creator);
    expect(inbox.notifications[0]).toMatchObject({
      type: "comment",
      actor: { name: "Riya" },
      video: { title: "Watch this" },
      comment: { message: "Loved it" },
    });
  });

  it("tells the comment's author about a reply, not the video's creator", async () => {
    const creator = await createUser();
    const asker = await createUser("Riya");
    const replier = await createUser("Sam");
    const row = await createVideo(creator.id);

    const parent = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", asker.cookie)
      .send({ message: "How long did this take?" });

    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", replier.cookie)
      .send({ message: "About an hour", parentCommentId: parent.body.comment.id });

    const askerInbox = await inboxOf(asker);
    expect(askerInbox.notifications[0]).toMatchObject({
      type: "reply",
      actor: { name: "Sam" },
    });

    // The creator hears about the original comment only — one notification,
    // not a second copy of the reply.
    const creatorInbox = await inboxOf(creator);
    expect(creatorInbox.notifications).toHaveLength(1);
    expect(creatorInbox.notifications[0]!.type).toBe("comment");
  });

  it("says nothing when you comment on your own video", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", creator.cookie)
      .send({ message: "Talking to myself" });

    expect((await inboxOf(creator)).notifications).toHaveLength(0);
  });

  it("says nothing when you reply to your own comment", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    const parent = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "First" });
    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Adding to that", parentCommentId: parent.body.comment.id });

    const inbox = await inboxOf(fan);
    expect(inbox.notifications).toHaveLength(0);
  });

  it("goes away with the comment it describes", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    const posted = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Deleted later" });
    expect((await inboxOf(creator)).notifications).toHaveLength(1);

    await request(app)
      .delete(`/api/comments/${posted.body.comment.id}`)
      .set("Cookie", creator.cookie);

    // A notification pointing at a comment that no longer exists would open an
    // empty thread.
    expect((await inboxOf(creator)).notifications).toHaveLength(0);
  });
});

describe("POST /api/notifications/read", () => {
  const seedTwo = async () => {
    const creator = await createUser();
    const fan = await createUser();
    const a = await createVideo(creator.id, { title: "A" });
    const b = await createVideo(creator.id, { title: "B" });

    for (const row of [a, b]) {
      await request(app)
        .post(`/api/videos/${row.id}/comments`)
        .set("Cookie", fan.cookie)
        .send({ message: "hi" });
    }
    return creator;
  };

  it("marks everything read", async () => {
    const creator = await seedTwo();
    expect((await inboxOf(creator)).unreadCount).toBe(2);

    const res = await request(app)
      .post("/api/notifications/read")
      .set("Cookie", creator.cookie)
      .send({});

    expect(res.body.unreadCount).toBe(0);
    expect((await inboxOf(creator)).notifications.every((n) => n.isRead)).toBe(true);
  });

  it("marks only the ids given", async () => {
    const creator = await seedTwo();
    const inbox = await inboxOf(creator);

    const res = await request(app)
      .post("/api/notifications/read")
      .set("Cookie", creator.cookie)
      .send({ ids: [inbox.notifications[0]!.id] });

    expect(res.body.unreadCount).toBe(1);
  });

  it("cannot mark someone else's notification read", async () => {
    const creator = await seedTwo();
    const stranger = await createUser();
    const inbox = await inboxOf(creator);

    await request(app)
      .post("/api/notifications/read")
      .set("Cookie", stranger.cookie)
      .send({ ids: inbox.notifications.map((n) => n.id) });

    // The update is scoped to the caller, so a forged id matches nothing.
    expect((await inboxOf(creator)).unreadCount).toBe(2);
  });
});

describe("GET /api/notifications/unread-count", () => {
  it("is the number the bell shows", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);
    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "hi" });

    const res = await request(app)
      .get("/api/notifications/unread-count")
      .set("Cookie", creator.cookie);

    expect(res.body).toEqual({ unreadCount: 1 });
  });
});
