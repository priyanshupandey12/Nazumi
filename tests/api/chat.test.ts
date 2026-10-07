import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, createUser, type TestUser } from "../helpers.js";
import { attachChatServer, roomSize } from "../../src/chat/chat.server.js";
import { db } from "../../src/db/db.js";
import { chatMessage } from "../../src/db/Schema.js";

let server: Server;
let port: number;
let stopChat: () => void;

beforeAll(async () => {
  server = createServer(app);
  stopChat = attachChatServer(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  stopChat();
  // server.close() waits for every connection to end, and a websocket never
  // ends on its own — so anything still attached has to be cut loose first.
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

type Frame = Record<string, unknown> & { type: string };

/** A connection that queues frames, so a test can await the one it wants. */
class TestClient {
  readonly socket: WebSocket;
  private readonly frames: Frame[] = [];
  private readonly waiting: Array<(frame: Frame) => void> = [];

  constructor(streamId: string, cookie?: string) {
    this.socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/chat?streamId=${encodeURIComponent(streamId)}`,
      cookie ? { headers: { Cookie: cookie } } : undefined,
    );

    this.socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      const next = this.waiting.shift();
      if (next) next(frame);
      else this.frames.push(frame);
    });
  }

  /**
   * Resolves with the next frame of this type, ignoring others before it.
   *
   * `match` narrows further, which matters for frames that arrive repeatedly:
   * a viewer sees a `viewers` count for its own join before anyone else's.
   */
  next(
    type: string,
    timeoutMs = 4_000,
    match: (frame: Frame) => boolean = () => true,
  ): Promise<Frame> {
    const queued = this.frames.findIndex(
      (frame) => frame.type === type && match(frame),
    );
    if (queued >= 0) return Promise.resolve(this.frames.splice(queued, 1)[0]!);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for "${type}"`)),
        timeoutMs,
      );

      const settle = (frame: Frame) => {
        if (frame.type !== type || !match(frame)) {
          this.waiting.unshift(settle);
          return;
        }
        clearTimeout(timer);
        resolve(frame);
      };

      this.waiting.push(settle);
    });
  }

  send(payload: unknown) {
    this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.socket.close();
  }

  /** Resolves once the server has accepted or rejected the upgrade. */
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", (error) => reject(error));
    });
  }
}

/** Polls until the room settles, since a disconnect is not instantaneous. */
const waitForRoom = async (streamId: string, size: number, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (roomSize(streamId) === size) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`room stayed at ${roomSize(streamId)}, expected ${size}`);
};

const makeStream = async (owner: TestUser, title = "Chat test") => {
  const res = await request(app)
    .post("/api/livestreams")
    .set("Cookie", owner.cookie)
    .send({ title });
  return res.body.stream.id as string;
};

describe("connecting", () => {
  it("refuses a connection with no session", async () => {
    const creator = await createUser();
    const streamId = await makeStream(creator);

    const client = new TestClient(streamId);

    // Chat needs an account, the same as commenting does.
    await expect(client.opened()).rejects.toThrow(/401/);
  });

  it("refuses a stream that does not exist", async () => {
    const viewer = await createUser();
    const client = new TestClient(
      "01a00000-0000-7000-8000-000000000000",
      viewer.cookie,
    );

    await expect(client.opened()).rejects.toThrow(/404/);
  });

  it("refuses a connection with no stream id", async () => {
    const viewer = await createUser();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`, {
      headers: { Cookie: viewer.cookie },
    });

    await expect(
      new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
    ).rejects.toThrow(/400/);
  });

  it("greets a viewer with who they are", async () => {
    const creator = await createUser("Ada");
    const streamId = await makeStream(creator);

    const client = new TestClient(streamId, creator.cookie);
    await client.opened();

    const ready = await client.next("ready");
    expect(ready.streamId).toBe(streamId);
    expect((ready.you as { name: string }).name).toBe("Ada");

    client.close();
  });
});

describe("talking", () => {
  it("fans a message out to everyone in the room", async () => {
    const creator = await createUser("Ada");
    const viewer = await createUser("Riya");
    const streamId = await makeStream(creator);

    const a = new TestClient(streamId, creator.cookie);
    const b = new TestClient(streamId, viewer.cookie);
    await Promise.all([a.opened(), b.opened()]);
    await Promise.all([a.next("ready"), b.next("ready")]);

    b.send({ type: "message", text: "hello everyone" });

    const seenByOther = await a.next("message");
    const seenBySender = await b.next("message");

    expect((seenByOther.message as { message: string }).message).toBe("hello everyone");
    expect((seenByOther.message as { author: { name: string } }).author.name).toBe("Riya");
    // The sender sees their own message through the same path, so ordering is
    // identical for everyone.
    expect((seenBySender.message as { message: string }).message).toBe("hello everyone");

    a.close();
    b.close();
  });

  it("does not leak messages into another stream's room", async () => {
    const creator = await createUser();
    const first = await makeStream(creator, "One");
    const second = await makeStream(creator, "Two");

    const a = new TestClient(first, creator.cookie);
    const b = new TestClient(second, creator.cookie);
    await Promise.all([a.opened(), b.opened()]);
    await Promise.all([a.next("ready"), b.next("ready")]);

    a.send({ type: "message", text: "only in the first room" });
    await a.next("message");

    await expect(b.next("message", 800)).rejects.toThrow(/timed out/);

    a.close();
    b.close();
  });

  it("persists messages and replays them to someone arriving later", async () => {
    const creator = await createUser();
    const streamId = await makeStream(creator);

    const first = new TestClient(streamId, creator.cookie);
    await first.opened();
    await first.next("ready");
    first.send({ type: "message", text: "said before you arrived" });
    await first.next("message");
    first.close();

    const later = new TestClient(streamId, creator.cookie);
    await later.opened();
    const history = await later.next("history");

    expect((history.messages as Array<{ message: string }>).map((m) => m.message)).toContain(
      "said before you arrived",
    );

    later.close();
  });

  it("ignores an empty message and refuses an over-long one", async () => {
    const creator = await createUser();
    const streamId = await makeStream(creator);

    const client = new TestClient(streamId, creator.cookie);
    await client.opened();
    await client.next("ready");

    client.send({ type: "message", text: "   " });
    client.send({ type: "message", text: "x".repeat(401) });

    const error = await client.next("error");
    expect(error.message).toMatch(/limited to/i);

    // Neither was stored.
    expect(await db.select().from(chatMessage)).toHaveLength(0);

    client.close();
  });

  it("survives a malformed frame", async () => {
    const creator = await createUser();
    const streamId = await makeStream(creator);

    const client = new TestClient(streamId, creator.cookie);
    await client.opened();
    await client.next("ready");

    client.socket.send("not json at all");
    const error = await client.next("error");
    expect(error.message).toMatch(/malformed/i);

    // The connection stays usable afterwards.
    client.send({ type: "message", text: "still here" });
    const message = await client.next("message");
    expect((message.message as { message: string }).message).toBe("still here");

    client.close();
  });
});

describe("moderation", () => {
  it("lets the broadcaster remove a message", async () => {
    const creator = await createUser();
    const viewer = await createUser();
    const streamId = await makeStream(creator);

    const host = new TestClient(streamId, creator.cookie);
    const guest = new TestClient(streamId, viewer.cookie);
    await Promise.all([host.opened(), guest.opened()]);
    await Promise.all([host.next("ready"), guest.next("ready")]);

    guest.send({ type: "message", text: "something to remove" });
    const posted = await host.next("message");
    const id = (posted.message as { id: string }).id;

    host.send({ type: "delete", id });

    const removed = await guest.next("deleted");
    expect(removed.id).toBe(id);
    expect(await db.select().from(chatMessage).where(eq(chatMessage.id, id))).toHaveLength(0);

    host.close();
    guest.close();
  });

  it("refuses a delete from an ordinary viewer", async () => {
    const creator = await createUser();
    const viewer = await createUser();
    const streamId = await makeStream(creator);

    const host = new TestClient(streamId, creator.cookie);
    const guest = new TestClient(streamId, viewer.cookie);
    await Promise.all([host.opened(), guest.opened()]);
    await Promise.all([host.next("ready"), guest.next("ready")]);

    guest.send({ type: "message", text: "mine" });
    const posted = await guest.next("message");
    const id = (posted.message as { id: string }).id;

    guest.send({ type: "delete", id });

    const error = await guest.next("error");
    expect(error.message).toMatch(/broadcaster/i);
    expect(await db.select().from(chatMessage).where(eq(chatMessage.id, id))).toHaveLength(1);

    host.close();
    guest.close();
  });
});

describe("rooms", () => {
  it("counts viewers and releases them on disconnect", async () => {
    const creator = await createUser();
    const viewer = await createUser();
    const streamId = await makeStream(creator);

    const a = new TestClient(streamId, creator.cookie);
    await a.opened();
    await a.next("ready");

    const b = new TestClient(streamId, viewer.cookie);
    await b.opened();

    const count = await a.next("viewers", 4_000, (frame) => frame.count === 2);
    expect(count.count).toBe(2);

    // Asserted against the server's own view rather than a broadcast frame:
    // every viewer also receives a count for its own join, so frame order
    // alone cannot tell the two apart.
    b.close();
    await waitForRoom(streamId, 1);
    expect(roomSize(streamId)).toBe(1);

    a.close();
    // An empty room must be dropped rather than accumulating forever.
    await waitForRoom(streamId, 0);
    expect(roomSize(streamId)).toBe(0);
  });
});
