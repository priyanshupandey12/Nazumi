import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser, createVideo } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { user } from "../../src/db/Schema.js";

const setProfile = (viewer: { cookie: string }, body: unknown) =>
  request(app).patch("/api/me").set("Cookie", viewer.cookie).send(body);

describe("GET /api/me", () => {
  it("needs a session", async () => {
    expect((await request(app).get("/api/me")).status).toBe(401);
  });

  it("falls back to the account name before anything is set", async () => {
    const viewer = await createUser("Ada Lovelace");

    const res = await request(app).get("/api/me").set("Cookie", viewer.cookie);

    expect(res.body.profile).toMatchObject({
      name: "Ada Lovelace",
      displayName: null,
      bio: null,
    });
  });
});

describe("PATCH /api/me", () => {
  it("sets a channel name without touching the account name", async () => {
    const viewer = await createUser("Ada Lovelace");

    const res = await setProfile(viewer, { displayName: "Ada Makes Things" });

    expect(res.status).toBe(200);
    expect(res.body.profile.name).toBe("Ada Makes Things");
    // The Google-sourced name is left intact so a later sign-in cannot clash.
    expect(res.body.profile.accountName).toBe("Ada Lovelace");

    const [row] = await db.select().from(user).where(eq(user.id, viewer.id));
    expect(row?.name).toBe("Ada Lovelace");
    expect(row?.displayName).toBe("Ada Makes Things");
  });

  it("falls back again when the channel name is cleared", async () => {
    const viewer = await createUser("Ada Lovelace");
    await setProfile(viewer, { displayName: "Temporary" });

    const res = await setProfile(viewer, { displayName: "   " });

    expect(res.body.profile.displayName).toBeNull();
    expect(res.body.profile.name).toBe("Ada Lovelace");
  });

  it("stores a bio", async () => {
    const viewer = await createUser();

    const res = await setProfile(viewer, { bio: "I make videos about databases." });

    expect(res.body.profile.bio).toBe("I make videos about databases.");
  });

  it("refuses an over-long channel name or bio", async () => {
    const viewer = await createUser();

    expect((await setProfile(viewer, { displayName: "x".repeat(51) })).status).toBe(400);
    expect((await setProfile(viewer, { bio: "x".repeat(501) })).status).toBe(400);
  });

  it("stores a new avatar and clears it on null", async () => {
    const viewer = await createUser();

    const set = await setProfile(viewer, {
      avatarUrl: "data:image/png;base64,AAAA",
    });
    expect(set.body.profile.avatarUrl).toMatch(/^https:\/\/res\.cloudinary\.test\//);

    const cleared = await setProfile(viewer, { avatarUrl: null });
    expect(cleared.body.profile.avatarUrl).toBeNull();
  });

  it("rejects an empty patch rather than reporting a no-op success", async () => {
    const viewer = await createUser();
    expect((await setProfile(viewer, {})).status).toBe(400);
  });

  it("needs a session", async () => {
    expect((await request(app).patch("/api/me").send({ bio: "hi" })).status).toBe(401);
  });
});

describe("channel identity everywhere it is shown", () => {
  it("names the creator on their channel page", async () => {
    const creator = await createUser("Ada Lovelace");
    await setProfile(creator, {
      displayName: "Ada Makes Things",
      bio: "Databases, mostly.",
    });

    const res = await request(app).get(`/api/creators/${creator.id}`);

    expect(res.body.creator).toMatchObject({
      name: "Ada Makes Things",
      bio: "Databases, mostly.",
    });
  });

  it("names the creator under the player", async () => {
    const creator = await createUser("Ada Lovelace");
    await setProfile(creator, { displayName: "Ada Makes Things" });
    const row = await createVideo(creator.id);

    const res = await request(app).get(`/api/videos/${row.id}`);

    expect(res.body.creator.name).toBe("Ada Makes Things");
  });

  it("names a commenter in the thread, including their own new comment", async () => {
    const creator = await createUser();
    const fan = await createUser("Riya Sharma");
    await setProfile(fan, { displayName: "Riya Reviews" });
    const row = await createVideo(creator.id);

    const posted = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Nice" });

    // The echo of a freshly posted comment must match what the list returns,
    // or the author's name changes under them on refresh.
    expect(posted.body.comment.author.name).toBe("Riya Reviews");

    const list = await request(app).get(`/api/videos/${row.id}/comments`);
    expect(list.body.comments[0].author.name).toBe("Riya Reviews");
  });

  it("names the actor in a notification", async () => {
    const creator = await createUser();
    const fan = await createUser("Riya Sharma");
    await setProfile(fan, { displayName: "Riya Reviews" });
    const row = await createVideo(creator.id);

    await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "Nice" });

    const res = await request(app)
      .get("/api/notifications")
      .set("Cookie", creator.cookie);

    expect(res.body.notifications[0].actor.name).toBe("Riya Reviews");
  });

  it("prefers a custom avatar over the account picture", async () => {
    const creator = await createUser();
    await db
      .update(user)
      .set({ image: "https://google.test/photo.jpg" })
      .where(eq(user.id, creator.id));
    const row = await createVideo(creator.id);

    const before = await request(app).get(`/api/videos/${row.id}`);
    expect(before.body.creator.image).toBe("https://google.test/photo.jpg");

    await setProfile(creator, { avatarUrl: "data:image/png;base64,AAAA" });

    const after = await request(app).get(`/api/videos/${row.id}`);
    expect(after.body.creator.image).toMatch(/^https:\/\/res\.cloudinary\.test\//);
  });
});
