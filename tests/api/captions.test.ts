import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser, createVideo } from "../helpers.js";
import { db } from "../../src/db/db.js";
import { videoCaption } from "../../src/db/Schema.js";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
This is the first line.
`;

const upload = (
  owner: { cookie: string },
  videoId: string,
  body: Record<string, unknown>,
) =>
  request(app)
    .post(`/api/videos/${videoId}/captions`)
    .set("Cookie", owner.cookie)
    .send(body);

describe("POST /api/videos/:id/captions", () => {
  it("refuses anyone but the creator", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const row = await createVideo(creator.id);

    const res = await upload(stranger, row.id, {
      language: "en",
      label: "English",
      content: VTT,
    });

    expect(res.status).toBe(404);
  });

  it("stores a track and makes the first one the default", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    const res = await upload(creator, row.id, {
      language: "en",
      label: "English",
      content: VTT,
    });

    expect(res.status).toBe(201);
    expect(res.body.caption).toMatchObject({
      language: "en",
      label: "English",
      isDefault: true,
      source: "uploaded",
    });
  });

  it("does not make a second track the default", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    await upload(creator, row.id, { language: "en", label: "English", content: VTT });
    const second = await upload(creator, row.id, {
      language: "fr",
      label: "French",
      content: VTT,
    });

    expect(second.body.caption.isDefault).toBe(false);
  });

  it("refuses a file that is not WebVTT", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    // A browser gives no useful error for a malformed track, so this has to be
    // caught here rather than failing silently in the player.
    const res = await upload(creator, row.id, {
      language: "en",
      content: "1\n00:00:01,000 --> 00:00:04,000\nAn SRT file, not VTT.\n",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/WEBVTT/);
  });

  it("requires a language and some content", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    expect((await upload(creator, row.id, { content: VTT })).status).toBe(400);
    expect((await upload(creator, row.id, { language: "en", content: "" })).status).toBe(400);
  });

  it("falls back to the language code when no label is given", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    const res = await upload(creator, row.id, { language: "pt-BR", content: VTT });

    expect(res.body.caption.label).toBe("pt-BR");
  });

  it("replaces rather than duplicating a language", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    await upload(creator, row.id, { language: "en", label: "English", content: VTT });
    const again = await upload(creator, row.id, {
      language: "en",
      label: "English (corrected)",
      content: `${VTT}\n00:00:05.000 --> 00:00:08.000\nA second line.\n`,
    });

    expect(again.status).toBe(201);
    // Two "English" entries in the player menu would be nonsense.
    const rows = await db
      .select()
      .from(videoCaption)
      .where(eq(videoCaption.videoId, row.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("English (corrected)");
  });
});

describe("GET /api/videos/:id/captions", () => {
  it("lists tracks for a published video", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    await upload(creator, row.id, { language: "en", label: "English", content: VTT });

    const res = await request(app).get(`/api/videos/${row.id}/captions`);

    expect(res.status).toBe(200);
    expect(res.body.captions).toHaveLength(1);
    // The payload is the track list, not the transcripts.
    expect(res.body.captions[0]).not.toHaveProperty("content");
  });

  it("keeps a draft's captions private", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const draft = await createVideo(creator.id, { isPublished: false });
    await upload(creator, draft.id, { language: "en", content: VTT });

    expect((await request(app).get(`/api/videos/${draft.id}/captions`)).status).toBe(404);
    expect(
      (
        await request(app)
          .get(`/api/videos/${draft.id}/captions`)
          .set("Cookie", creator.cookie)
      ).status,
    ).toBe(200);
  });
});

describe("GET /api/captions/:id/file", () => {
  it("serves the VTT as text/vtt", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    const created = await upload(creator, row.id, { language: "en", content: VTT });

    const res = await request(app).get(`/api/captions/${created.body.caption.id}/file`);

    expect(res.status).toBe(200);
    // A track element is ignored unless the content type is right.
    expect(res.headers["content-type"]).toMatch(/text\/vtt/);
    expect(res.text).toContain("WEBVTT");
  });

  it("serves a draft's track too, because a <track> cannot authenticate", async () => {
    // Deliberate: the file is a capability URL. A track element fetches with
    // crossorigin="anonymous" and sends no cookies, so a visibility check here
    // would leave a creator previewing their own draft with no subtitles. The
    // id is unguessable and the *list* endpoint is what stays scoped.
    const creator = await createUser();
    const draft = await createVideo(creator.id, { isPublished: false });
    const created = await upload(creator, draft.id, { language: "en", content: VTT });

    const res = await request(app).get(`/api/captions/${created.body.caption.id}/file`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/vtt/);
  });

  it("404s for an id that does not exist", async () => {
    const res = await request(app).get(
      "/api/captions/01a00000-0000-7000-8000-000000000000/file",
    );
    expect(res.status).toBe(404);
  });
});

describe("managing tracks", () => {
  it("deletes one, and promotes another to default", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    const first = await upload(creator, row.id, { language: "en", content: VTT });
    await upload(creator, row.id, { language: "fr", content: VTT });

    const res = await request(app)
      .delete(`/api/captions/${first.body.caption.id}`)
      .set("Cookie", creator.cookie);

    expect(res.status).toBe(200);
    // Otherwise the video would have tracks but none selected.
    const rows = await db
      .select()
      .from(videoCaption)
      .where(eq(videoCaption.videoId, row.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isDefault).toBe(true);
  });

  it("refuses a delete by anyone but the creator", async () => {
    const creator = await createUser();
    const stranger = await createUser();
    const row = await createVideo(creator.id);
    const created = await upload(creator, row.id, { language: "en", content: VTT });

    const res = await request(app)
      .delete(`/api/captions/${created.body.caption.id}`)
      .set("Cookie", stranger.cookie);

    expect(res.status).toBe(403);
  });

  it("moves the default to another track", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    await upload(creator, row.id, { language: "en", content: VTT });
    const french = await upload(creator, row.id, { language: "fr", content: VTT });

    await request(app)
      .post(`/api/captions/${french.body.caption.id}/default`)
      .set("Cookie", creator.cookie);

    const rows = await db
      .select()
      .from(videoCaption)
      .where(eq(videoCaption.videoId, row.id));

    // Exactly one default, always.
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
    expect(rows.find((row) => row.isDefault)?.language).toBe("fr");
  });

  it("goes away with the video", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);
    await upload(creator, row.id, { language: "en", content: VTT });

    await request(app).delete(`/api/videos/${row.id}`).set("Cookie", creator.cookie);

    expect(await db.select().from(videoCaption)).toHaveLength(0);
  });
});
