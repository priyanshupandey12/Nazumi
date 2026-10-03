import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, createUser, createVideo, createVideos } from "../helpers.js";

const titles = (res: request.Response): string[] =>
  (res.body.videos ?? res.body.data ?? []).map((v: { title: string }) => v.title);

describe("GET /api/videos/categories", () => {
  it("is not mistaken for a video id", async () => {
    // "/categories" sits before "/:id" in the router; if that ever flips, this
    // returns a 404 for a video called "categories".
    const res = await request(app).get("/api/videos/categories");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.categories)).toBe(true);
  });

  it("counts published videos per category, most used first", async () => {
    const user = await createUser();
    await createVideos(user.id, [
      { title: "A", category: "Music" },
      { title: "B", category: "Music" },
      { title: "C", category: "Anime" },
    ]);

    const res = await request(app).get("/api/videos/categories");

    expect(res.body.categories).toEqual([
      { name: "Music", count: 2 },
      { name: "Anime", count: 1 },
    ]);
  });

  it("ignores drafts and videos with no category", async () => {
    const user = await createUser();
    await createVideos(user.id, [
      { title: "Counted", category: "Music" },
      { title: "A draft", category: "Music", isPublished: false },
      { title: "Uncategorised", category: null },
    ]);

    const res = await request(app).get("/api/videos/categories");

    expect(res.body.categories).toEqual([{ name: "Music", count: 1 }]);
  });
});

describe("GET /api/videos/:id/related", () => {
  it("leads with a video sharing the category", async () => {
    const user = await createUser();
    const [source] = await createVideos(user.id, [
      { title: "Source", category: "Music", tags: "guitar" },
    ]);
    await createVideos(user.id, [
      { title: "Unrelated", category: "Food", tags: "ramen" },
      { title: "Same category", category: "Music", tags: "drums" },
    ]);

    const res = await request(app).get(`/api/videos/${source!.id}/related`);

    expect(res.status).toBe(200);
    expect(titles(res)[0]).toBe("Same category");
  });

  it("leads with a video sharing a tag", async () => {
    const user = await createUser();
    const [source] = await createVideos(user.id, [
      { title: "Source", category: "Sport", tags: "rock, outdoors" },
    ]);
    await createVideos(user.id, [
      { title: "Unrelated", category: "Food", tags: "ramen" },
      { title: "Shares a tag", category: "Music", tags: "rock" },
    ]);

    const res = await request(app).get(`/api/videos/${source!.id}/related`);

    expect(titles(res)[0]).toBe("Shares a tag");
  });

  it("never includes the video itself", async () => {
    const user = await createUser();
    const source = await createVideo(user.id, { title: "Source", category: "Music" });
    await createVideo(user.id, { title: "Other", category: "Music" });

    const res = await request(app).get(`/api/videos/${source.id}/related`);

    expect(titles(res)).not.toContain("Source");
  });

  it("tops up with recent videos rather than returning an empty rail", async () => {
    const user = await createUser();
    const source = await createVideo(user.id, {
      title: "Source",
      category: "Nothing in common",
      tags: "unique",
    });
    await createVideos(user.id, [{ title: "Recent A" }, { title: "Recent B" }]);

    const res = await request(app).get(`/api/videos/${source.id}/related`);

    expect(titles(res)).toHaveLength(2);
  });

  it("offers nothing when there is nothing else published", async () => {
    const user = await createUser();
    const source = await createVideo(user.id, { title: "Alone" });
    await createVideo(user.id, { title: "A draft", isPublished: false });

    const res = await request(app).get(`/api/videos/${source.id}/related`);

    expect(titles(res)).toEqual([]);
  });

  it("404s for a video that does not exist", async () => {
    const res = await request(app).get(
      "/api/videos/01a00000-0000-7000-8000-000000000000/related",
    );
    expect(res.status).toBe(404);
  });
});
