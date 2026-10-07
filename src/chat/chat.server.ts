import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { fromNodeHeaders } from "better-auth/node";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "../lib/auth.js";
import { db } from "../db/db.js";
import { chatMessage, livestreaming, user } from "../db/Schema.js";
import { resolveIdentity } from "../lib/identity.js";
import { consume } from "../middlware/rateLimit.js";

/*

  Browser
  |
  | ws://host/ws/chat?streamId=...
  v
Upgrade: the session cookie decides who this is
  |
  v
One room per stream
  |
  +--> recent history on join
  +--> messages fan out to everyone in the room
  +--> the creator can delete any message in their own room

*/

const MAX_MESSAGE = 400;
const HISTORY_SIZE = 50;

/** Messages per viewer per minute. Generous for talking, tight for a script. */
const RATE_LIMIT = 20;
const RATE_WINDOW = 60;

/** A dead connection is only detectable by its silence. */
const HEARTBEAT_MS = 30_000;

type Viewer = {
  socket: WebSocket;
  streamId: string;
  userId: string;
  name: string;
  image: string | null;
  isCreator: boolean;
  alive: boolean;
};

type Outgoing =
  | { type: "ready"; streamId: string; you: { id: string; name: string } }
  | { type: "history"; messages: ChatPayload[] }
  | { type: "message"; message: ChatPayload }
  | { type: "deleted"; id: string }
  | { type: "viewers"; count: number }
  | { type: "error"; message: string };

type ChatPayload = {
  id: string;
  message: string;
  createdAt: string;
  author: { id: string; name: string; image: string | null };
};

/**
 * Rooms live in this process's memory.
 *
 * That is deliberate for now and a real limit: with two API instances, viewers
 * connected to different ones would not see each other. Crossing that needs
 * Redis pub/sub between instances, which is worth adding the day a second
 * instance exists and not before.
 */
const rooms = new Map<string, Set<Viewer>>();

const send = (socket: WebSocket, payload: Outgoing) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
};

const broadcast = (streamId: string, payload: Outgoing) => {
  const room = rooms.get(streamId);
  if (!room) return;

  for (const viewer of room) send(viewer.socket, payload);
};

const announceViewers = (streamId: string) => {
  broadcast(streamId, {
    type: "viewers",
    count: rooms.get(streamId)?.size ?? 0,
  });
};

const join = (viewer: Viewer) => {
  const room = rooms.get(viewer.streamId) ?? new Set<Viewer>();
  room.add(viewer);
  rooms.set(viewer.streamId, room);
  announceViewers(viewer.streamId);
};

const leave = (viewer: Viewer) => {
  const room = rooms.get(viewer.streamId);
  if (!room) return;

  room.delete(viewer);

  // An empty room is just a leak waiting to accumulate.
  if (room.size === 0) rooms.delete(viewer.streamId);
  else announceViewers(viewer.streamId);
};

/** Oldest first, so the client can append without re-sorting. */
const recentHistory = async (streamId: string): Promise<ChatPayload[]> => {
  const rows = await db
    .select({
      id: chatMessage.id,
      message: chatMessage.message,
      createdAt: chatMessage.createdAt,
      authorId: user.id,
      authorName: user.name,
      authorImage: user.image,
      authorDisplayName: user.displayName,
      authorAvatarUrl: user.avatarUrl,
    })
    .from(chatMessage)
    .innerJoin(user, eq(chatMessage.userId, user.id))
    .where(eq(chatMessage.livestreamId, streamId))
    .orderBy(desc(chatMessage.id))
    .limit(HISTORY_SIZE);

  return rows
    .map((row) => ({
      id: row.id,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      author: resolveIdentity({
        id: row.authorId,
        name: row.authorName,
        image: row.authorImage,
        displayName: row.authorDisplayName,
        avatarUrl: row.authorAvatarUrl,
      }),
    }))
    .reverse();
};

const handleMessage = async (viewer: Viewer, raw: string) => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return send(viewer.socket, { type: "error", message: "Malformed message" });
  }

  const payload = (parsed ?? {}) as Record<string, unknown>;

  if (payload.type === "delete") {
    return handleDelete(viewer, payload);
  }

  if (payload.type !== "message") return;

  const text = typeof payload.text === "string" ? payload.text.trim() : "";

  if (!text) return;

  if (text.length > MAX_MESSAGE) {
    return send(viewer.socket, {
      type: "error",
      message: `Messages are limited to ${MAX_MESSAGE} characters`,
    });
  }

  const { allowed } = await consume(
    "chat",
    `u:${viewer.userId}`,
    RATE_LIMIT,
    RATE_WINDOW,
  );

  if (!allowed) {
    return send(viewer.socket, {
      type: "error",
      message: "You are sending messages too quickly.",
    });
  }

  const [saved] = await db
    .insert(chatMessage)
    .values({
      livestreamId: viewer.streamId,
      userId: viewer.userId,
      message: text,
    })
    .returning({ id: chatMessage.id, createdAt: chatMessage.createdAt });

  if (!saved) return;

  broadcast(viewer.streamId, {
    type: "message",
    message: {
      id: saved.id,
      message: text,
      createdAt: saved.createdAt.toISOString(),
      author: { id: viewer.userId, name: viewer.name, image: viewer.image },
    },
  });
};

/** The stream's creator moderates their own room; nobody else can. */
const handleDelete = async (viewer: Viewer, payload: Record<string, unknown>) => {
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) return;

  if (!viewer.isCreator) {
    return send(viewer.socket, {
      type: "error",
      message: "Only the broadcaster can remove messages",
    });
  }

  const deleted = await db
    .delete(chatMessage)
    .where(
      and(eq(chatMessage.id, id), eq(chatMessage.livestreamId, viewer.streamId)),
    )
    .returning({ id: chatMessage.id });

  if (deleted.length > 0) {
    broadcast(viewer.streamId, { type: "deleted", id });
  }
};

/**
 * Attaches the chat server to an existing HTTP server.
 *
 * Sharing the port matters: the browser sends the session cookie on the
 * upgrade request only because it is the same origin as the API.
 */
export const attachChatServer = (server: Server) => {
  // `noServer` so the upgrade can be rejected before a socket exists, rather
  // than accepting everyone and disconnecting them a moment later.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);

    if (url.pathname !== "/ws/chat") {
      socket.destroy();
      return;
    }

    const streamId = url.searchParams.get("streamId") ?? "";

    void (async () => {
      const refuse = (code: string) => {
        socket.write(`HTTP/1.1 ${code}\r\n\r\n`);
        socket.destroy();
      };

      if (!streamId) return refuse("400 Bad Request");

      const session = await auth.api
        .getSession({ headers: fromNodeHeaders(request.headers) })
        .catch(() => null);

      // Reading chat needs an account, the same as commenting does.
      if (!session) return refuse("401 Unauthorized");

      const [stream] = await db
        .select({ id: livestreaming.id, creatorId: livestreaming.creatorId })
        .from(livestreaming)
        .where(eq(livestreaming.id, streamId))
        .limit(1);

      if (!stream) return refuse("404 Not Found");

      const [account] = await db
        .select({ displayName: user.displayName, avatarUrl: user.avatarUrl })
        .from(user)
        .where(eq(user.id, session.user.id))
        .limit(1);

      const identity = resolveIdentity({
        id: session.user.id,
        name: session.user.name,
        image: session.user.image ?? null,
        displayName: account?.displayName ?? null,
        avatarUrl: account?.avatarUrl ?? null,
      });

      wss.handleUpgrade(request, socket, head, (ws) => {
        const viewer: Viewer = {
          socket: ws,
          streamId,
          userId: identity.id,
          name: identity.name,
          image: identity.image,
          isCreator: stream.creatorId === identity.id,
          alive: true,
        };

        join(viewer);

        send(ws, {
          type: "ready",
          streamId,
          you: { id: viewer.userId, name: viewer.name },
        });

        void recentHistory(streamId).then((messages) =>
          send(ws, { type: "history", messages }),
        );

        ws.on("pong", () => {
          viewer.alive = true;
        });

        ws.on("message", (data) => {
          void handleMessage(viewer, data.toString()).catch((error) => {
            console.error("[chat] message failed:", error);
          });
        });

        ws.on("close", () => leave(viewer));
        ws.on("error", () => leave(viewer));
      });
    })().catch((error) => {
      console.error("[chat] upgrade failed:", error);
      socket.destroy();
    });
  });

  // A browser that goes to sleep or loses its network leaves a socket that
  // looks open forever; the ping is the only way to notice.
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const viewer of room) {
        if (!viewer.alive) {
          viewer.socket.terminate();
          continue;
        }
        viewer.alive = false;
        viewer.socket.ping();
      }
    }
  }, HEARTBEAT_MS);

  console.log("[chat] websocket listening on /ws/chat");

  return () => {
    clearInterval(heartbeat);

    // A websocket never ends on its own, so a shutdown that only closes the
    // server would wait on these forever. Terminate them explicitly.
    for (const room of rooms.values()) {
      for (const viewer of room) viewer.socket.terminate();
    }
    rooms.clear();

    wss.close();
  };
};

/** Exposed for tests, which assert rooms do not leak. */
export const roomSize = (streamId: string) => rooms.get(streamId)?.size ?? 0;
