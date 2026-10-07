import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { livestreaming } from "../../src/db/Schema.js";

const createStream = (owner: { cookie: string }, title = "Friday night build") =>
  request(app).post("/api/livestreams").set("Cookie", owner.cookie).send({ title });

describe("POST /api/live/auth", () => {
  it("allows a publish whose path is a real stream key", async () => {
    const creator = await createUser();
    const created = await createStream(creator);

    const res = await request(app)
      .post("/api/live/auth")
      .send({ action: "publish", path: created.body.stream.streamKey });

    expect(res.status).toBe(200);
  });

  it("refuses a publish to a key that does not exist", async () => {
    // Otherwise anyone who guesses a path can broadcast on your server.
    const res = await request(app)
      .post("/api/live/auth")
      .send({ action: "publish", path: "not-a-real-key" });

    expect(res.status).toBe(401);
  });

  it("refuses a publish with no path at all", async () => {
    const res = await request(app).post("/api/live/auth").send({ action: "publish" });
    expect(res.status).toBe(401);
  });

  it("allows reading, because watching is public", async () => {
    const res = await request(app)
      .post("/api/live/auth")
      .send({ action: "read", path: "anything" });

    expect(res.status).toBe(200);
  });
});

describe("managing a stream", () => {
  it("needs a session", async () => {
    expect((await request(app).post("/api/livestreams").send({ title: "x" })).status).toBe(401);
    expect((await request(app).get("/api/livestreams/mine")).status).toBe(401);
  });

  it("creates one with a key and the ingest URL", async () => {
    const creator = await createUser();

    const res = await createStream(creator);

    expect(res.status).toBe(201);
    expect(res.body.stream).toMatchObject({ title: "Friday night build", status: "offline" });
    expect(res.body.stream.streamKey).toMatch(/^live_[0-9a-f]{36}$/);
    expect(res.body.stream.ingestUrl).toMatch(/^rtmp:\/\//);
  });

  it("requires a title", async () => {
    const creator = await createUser();
    const res = await request(app)
      .post("/api/livestreams")
      .set("Cookie", creator.cookie)
      .send({ title: "   " });

    expect(res.status).toBe(400);
  });

  it("gives each stream a different key", async () => {
    const creator = await createUser();
    const first = await createStream(creator, "One");
    const second = await createStream(creator, "Two");

    expect(first.body.stream.streamKey).not.toBe(second.body.stream.streamKey);
  });

  it("rotates a key, so a leaked one stops working", async () => {
    const creator = await createUser();
    const created = await createStream(creator);
    const original = created.body.stream.streamKey;

    const rotated = await request(app)
      .post(`/api/livestreams/${created.body.stream.id}/key`)
      .set("Cookie", creator.cookie);

    expect(rotated.body.stream.streamKey).not.toBe(original);

    // The old key must stop authorising publishes immediately.
    const oldKey = await request(app)
      .post("/api/live/auth")
      .send({ action: "publish", path: original });
    expect(oldKey.status).toBe(401);
  });

  it("refuses to rotate while the stream is live", async () => {
    const creator = await createUser();
    const created = await createStream(creator);
    await db
      .update(livestreaming)
      .set({ status: "live" })
      .where(eq(livestreaming.id, created.body.stream.id));

    const res = await request(app)
      .post(`/api/livestreams/${created.body.stream.id}/key`)
      .set("Cookie", creator.cookie);

    // Rotating mid-broadcast would cut the stream off.
    expect(res.status).toBe(409);
  });

  it("keeps streams to their owner", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const created = await createStream(creator);
    const id = created.body.stream.id;

    expect(
      (await request(app).patch(`/api/livestreams/${id}`).set("Cookie", stranger.cookie).send({ title: "Mine" })).status,
    ).toBe(403);
    expect(
      (await request(app).post(`/api/livestreams/${id}/key`).set("Cookie", stranger.cookie)).status,
    ).toBe(403);
    expect(
      (await request(app).delete(`/api/livestreams/${id}`).set("Cookie", stranger.cookie)).status,
    ).toBe(403);

    const mine = await request(app).get("/api/livestreams/mine").set("Cookie", stranger.cookie);
    expect(mine.body.streams).toHaveLength(0);
  });
});

describe("watching", () => {
  it("never exposes the stream key to a viewer", async () => {
    const creator = await createUser();
    const created = await createStream(creator);

    const res = await request(app).get(`/api/livestreams/${created.body.stream.id}`);

    expect(res.status).toBe(200);
    // The key is a credential typed into OBS; a viewer must never see it.
    expect(JSON.stringify(res.body)).not.toContain(created.body.stream.streamKey);
  });

  it("withholds the playback URL until the stream is actually live", async () => {
    const creator = await createUser();
    const created = await createStream(creator);
    const id = created.body.stream.id;

    const offline = await request(app).get(`/api/livestreams/${id}`);
    expect(offline.body.stream.playbackUrl).toBeNull();

    await db.update(livestreaming).set({ status: "live" }).where(eq(livestreaming.id, id));

    const live = await request(app).get(`/api/livestreams/${id}`);
    expect(live.body.stream.playbackUrl).toMatch(/\.m3u8$/);
  });

  it("lists only what is broadcasting right now", async () => {
    const creator = await createUser("Ada");
    const offline = await createStream(creator, "Not started");
    const live = await createStream(creator, "On air");
    await db
      .update(livestreaming)
      .set({ status: "live" })
      .where(eq(livestreaming.id, live.body.stream.id));

    const res = await request(app).get("/api/livestreams/live");

    expect(res.body.streams.map((s: { title: string }) => s.title)).toEqual(["On air"]);
    expect(res.body.streams[0].creator.name).toBe("Ada");
    expect(offline.body.stream.status).toBe("offline");
  });

  it("counts a view only while live", async () => {
    const creator = await createUser();
    const created = await createStream(creator);
    const id = created.body.stream.id;

    expect((await request(app).post(`/api/livestreams/${id}/view`)).status).toBe(409);

    await db.update(livestreaming).set({ status: "live" }).where(eq(livestreaming.id, id));

    expect((await request(app).post(`/api/livestreams/${id}/view`)).body.viewCount).toBe(1);
    expect((await request(app).post(`/api/livestreams/${id}/view`)).body.viewCount).toBe(2);
  });
});
