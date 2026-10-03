import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, createUser, createVideo } from "../helpers.js";

// Buckets are cleared before every test in tests/setup.ts.

describe("comment rate limit", () => {
  it("lets an ordinary conversation through", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post(`/api/videos/${row.id}/comments`)
        .set("Cookie", fan.cookie)
        .send({ message: `comment ${i}` });
      expect(res.status).toBe(201);
    }
  });

  it("answers 429 once someone is clearly scripting it", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    const statuses: number[] = [];
    for (let i = 0; i < 18; i++) {
      const res = await request(app)
        .post(`/api/videos/${row.id}/comments`)
        .set("Cookie", fan.cookie)
        .send({ message: `spam ${i}` });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 201)).toHaveLength(15);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("tells the caller how long to wait, in JSON", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    let limited: request.Response | null = null;
    for (let i = 0; i < 20 && !limited; i++) {
      const res = await request(app)
        .post(`/api/videos/${row.id}/comments`)
        .set("Cookie", fan.cookie)
        .send({ message: `x ${i}` });
      if (res.status === 429) limited = res;
    }

    expect(limited).not.toBeNull();
    expect(limited!.type).toBe("application/json");
    expect(limited!.headers["retry-after"]).toBe("60");
    expect(limited!.body.message).toMatch(/quickly|slow/i);
  });

  it("limits each account separately", async () => {
    const creator = await createUser();
    const noisy = await createUser();
    const quiet = await createUser();
    const row = await createVideo(creator.id);

    for (let i = 0; i < 16; i++) {
      await request(app)
        .post(`/api/videos/${row.id}/comments`)
        .set("Cookie", noisy.cookie)
        .send({ message: `x ${i}` });
    }

    // One account exhausting its budget must not silence everybody else.
    const other = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", quiet.cookie)
      .send({ message: "hello" });

    expect(other.status).toBe(201);
  });

  it("keeps separate budgets per action", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    for (let i = 0; i < 16; i++) {
      await request(app)
        .post(`/api/videos/${row.id}/comments`)
        .set("Cookie", fan.cookie)
        .send({ message: `x ${i}` });
    }

    // Running out of comments should not stop someone liking a video.
    const like = await request(app)
      .post(`/api/videos/${row.id}/like`)
      .set("Cookie", fan.cookie);

    expect(like.status).toBe(200);
  });

  it("reports the budget on every response", async () => {
    const creator = await createUser();
    const fan = await createUser();
    const row = await createVideo(creator.id);

    const res = await request(app)
      .post(`/api/videos/${row.id}/comments`)
      .set("Cookie", fan.cookie)
      .send({ message: "hi" });

    expect(res.headers["x-ratelimit-limit"]).toBe("15");
    expect(res.headers["x-ratelimit-remaining"]).toBe("14");
  });
});

describe("view counting", () => {
  it("is limited by address for signed-out callers", async () => {
    const creator = await createUser();
    const row = await createVideo(creator.id);

    const statuses: number[] = [];
    for (let i = 0; i < 125; i++) {
      statuses.push((await request(app).post(`/api/videos/${row.id}/view`)).status);
    }

    // Otherwise a loop inflates a view count for free.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
