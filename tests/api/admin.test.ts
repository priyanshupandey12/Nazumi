import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser, createVideo } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { notification, user, video } from "../../src/db/Schema.js";
import { notifyTranscodeFinished } from "../../src/lib/notify.js";

const makeAdmin = (id: string) =>
  db.update(user).set({ role: "admin" }).where(eq(user.id, id));

describe("GET /api/admin/users", () => {
  it("refuses anyone signed out", async () => {
    expect((await request(app).get("/api/admin/users")).status).toBe(401);
  });

  it("refuses an ordinary account", async () => {
    const viewer = await createUser();
    const res = await request(app).get("/api/admin/users").set("Cookie", viewer.cookie);
    expect(res.status).toBe(403);
  });

  it("lists accounts with their role and totals", async () => {
    const admin = await createUser("Admin");
    await makeAdmin(admin.id);
    const creator = await createUser("Ada");
    await createVideo(creator.id);

    const res = await request(app).get("/api/admin/users").set("Cookie", admin.cookie);

    expect(res.status).toBe(200);
    const ada = res.body.users.find((u: { name: string }) => u.name === "Ada");
    expect(ada).toMatchObject({ role: "user", videoCount: 1, subscriberCount: 0 });
  });

  it("searches by name or email", async () => {
    const admin = await createUser("Admin");
    await makeAdmin(admin.id);
    const target = await createUser("Findable Person");

    const byName = await request(app)
      .get("/api/admin/users?q=Findable")
      .set("Cookie", admin.cookie);
    const byEmail = await request(app)
      .get(`/api/admin/users?q=${encodeURIComponent(target.email)}`)
      .set("Cookie", admin.cookie);

    expect(byName.body.users).toHaveLength(1);
    expect(byEmail.body.users[0].id).toBe(target.id);
  });

  it("reads the role from the database, not the session", async () => {
    // A revoked admin must lose access on the next request rather than
    // whenever their session happens to be reissued.
    const admin = await createUser();
    await makeAdmin(admin.id);
    expect(
      (await request(app).get("/api/admin/users").set("Cookie", admin.cookie)).status,
    ).toBe(200);

    await db.update(user).set({ role: "user" }).where(eq(user.id, admin.id));

    expect(
      (await request(app).get("/api/admin/users").set("Cookie", admin.cookie)).status,
    ).toBe(403);
  });
});

describe("PATCH /api/admin/users/:id/role", () => {
  it("promotes and demotes another account", async () => {
    const admin = await createUser();
    await makeAdmin(admin.id);
    const target = await createUser();

    const promoted = await request(app)
      .patch(`/api/admin/users/${target.id}/role`)
      .set("Cookie", admin.cookie)
      .send({ role: "admin" });
    expect(promoted.body.role).toBe("admin");

    const demoted = await request(app)
      .patch(`/api/admin/users/${target.id}/role`)
      .set("Cookie", admin.cookie)
      .send({ role: "user" });
    expect(demoted.body.role).toBe("user");
  });

  it("refuses to let an admin change their own role", async () => {
    // Demoting the only admin locks everyone out of moderation with no way
    // back except the database.
    const admin = await createUser();
    await makeAdmin(admin.id);

    const res = await request(app)
      .patch(`/api/admin/users/${admin.id}/role`)
      .set("Cookie", admin.cookie)
      .send({ role: "user" });

    expect(res.status).toBe(400);
    const [row] = await db.select().from(user).where(eq(user.id, admin.id));
    expect(row?.role).toBe("admin");
  });

  it("rejects an unknown role", async () => {
    const admin = await createUser();
    await makeAdmin(admin.id);
    const target = await createUser();

    const res = await request(app)
      .patch(`/api/admin/users/${target.id}/role`)
      .set("Cookie", admin.cookie)
      .send({ role: "superuser" });

    expect(res.status).toBe(400);
  });

  it("refuses an ordinary account trying to promote itself", async () => {
    const viewer = await createUser();
    const other = await createUser();

    const res = await request(app)
      .patch(`/api/admin/users/${other.id}/role`)
      .set("Cookie", viewer.cookie)
      .send({ role: "admin" });

    expect(res.status).toBe(403);
  });

  it("404s for an account that does not exist", async () => {
    const admin = await createUser();
    await makeAdmin(admin.id);

    const res = await request(app)
      .patch("/api/admin/users/nobody/role")
      .set("Cookie", admin.cookie)
      .send({ role: "admin" });

    expect(res.status).toBe(404);
  });
});

describe("transcode notifications", () => {
  it("tells the creator when a video becomes ready", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, {
      status: "processing",
      isPublished: false,
    });

    await notifyTranscodeFinished({
      creatorId: creator.id,
      videoId: row.id,
      outcome: "ready",
    });

    const res = await request(app)
      .get("/api/notifications")
      .set("Cookie", creator.cookie);

    expect(res.body.notifications[0]).toMatchObject({
      type: "video_ready",
      video: { id: row.id },
      // The system did it, so there is nobody to attribute it to.
      actor: null,
    });
    expect(res.body.unreadCount).toBe(1);
  });

  it("tells the creator when a transcode fails", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id, {
      status: "failed",
      isPublished: false,
    });

    await notifyTranscodeFinished({
      creatorId: creator.id,
      videoId: row.id,
      outcome: "failed",
    });

    const res = await request(app)
      .get("/api/notifications")
      .set("Cookie", creator.cookie);

    expect(res.body.notifications[0].type).toBe("video_failed");
  });

  it("goes away with the video it describes", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    await notifyTranscodeFinished({
      creatorId: creator.id,
      videoId: row.id,
      outcome: "ready",
    });

    await db.delete(video).where(eq(video.id, row.id));

    expect(await db.select().from(notification)).toHaveLength(0);
  });
});
