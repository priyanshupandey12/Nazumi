import { eq, inArray } from "drizzle-orm";
import { db } from "../db/db.js";
import { livestreaming } from "../db/Schema.js";

/**
 * Keeps `livestreaming.status` in step with what is actually being published.
 *
 * MediaMTX decides this, not us — a broadcaster can drop off at any moment
 * without telling anyone. Its control API lists the paths currently publishing,
 * so the truth is read from there rather than inferred from the auth hook,
 * which only fires when a publish *starts* and says nothing about it ending.
 *
 * Polled rather than pushed because MediaMTX's own notifications are shell
 * commands run inside its container, which would mean baking a HTTP client
 * into that image just to call back here.
 */

const API_URL = process.env.MEDIA_API_URL ?? "http://localhost:9997";
const INTERVAL_MS = Number(process.env.LIVE_POLL_MS ?? 5_000);

type PathItem = { name: string; ready: boolean };

/** Stream keys currently publishing, or null when MediaMTX is unreachable. */
export const readActiveKeys = async (): Promise<Set<string> | null> => {
  try {
    const response = await fetch(`${API_URL}/v3/paths/list`, {
      signal: AbortSignal.timeout(4_000),
    });

    if (!response.ok) return null;

    const body = (await response.json()) as { items?: PathItem[] };

    return new Set(
      (body.items ?? []).filter((item) => item.ready).map((item) => item.name),
    );
  } catch {
    return null;
  }
};

/**
 * One reconciliation pass. Returns what changed, so the caller can log it.
 *
 * Unreachable is not the same as nothing-is-live: if MediaMTX cannot be
 * reached, every stream is left alone rather than being marked ended, which
 * would knock real broadcasts off the air over a blip.
 */
export const syncLiveStatuses = async (): Promise<{
  started: string[];
  ended: string[];
} | null> => {
  const active = await readActiveKeys();
  if (!active) return null;

  const streams = await db
    .select({
      id: livestreaming.id,
      title: livestreaming.title,
      streamKey: livestreaming.streamKey,
      status: livestreaming.status,
    })
    .from(livestreaming);

  const started: string[] = [];
  const ended: string[] = [];

  for (const stream of streams) {
    const isPublishing = active.has(stream.streamKey);

    if (isPublishing && stream.status !== "live") {
      started.push(stream.title);
      await db
        .update(livestreaming)
        .set({ status: "live" })
        .where(eq(livestreaming.id, stream.id));
      continue;
    }

    // "offline" is the state before a stream has ever run; only something that
    // was live becomes "ended".
    if (!isPublishing && stream.status === "live") {
      ended.push(stream.title);
      await db
        .update(livestreaming)
        .set({ status: "ended" })
        .where(eq(livestreaming.id, stream.id));
    }
  }

  return { started, ended };
};

/** Marks everything ended at boot, in case the last run died mid-broadcast. */
export const reconcileOnStart = async () => {
  const active = await readActiveKeys();

  if (!active) {
    // Without a reading, leaving the rows alone beats guessing.
    return;
  }

  const stale = await db
    .select({ id: livestreaming.id, streamKey: livestreaming.streamKey })
    .from(livestreaming)
    .where(eq(livestreaming.status, "live"));

  const orphaned = stale
    .filter((stream) => !active.has(stream.streamKey))
    .map((stream) => stream.id);

  if (orphaned.length > 0) {
    await db
      .update(livestreaming)
      .set({ status: "ended" })
      .where(inArray(livestreaming.id, orphaned));

    console.log(`[live] marked ${orphaned.length} stale stream(s) as ended`);
  }
};

export const startLiveMonitor = () => {
  void reconcileOnStart();

  const timer = setInterval(async () => {
    const result = await syncLiveStatuses();

    if (!result) return;

    for (const title of result.started) console.log(`[live] "${title}" went live`);
    for (const title of result.ended) console.log(`[live] "${title}" ended`);
  }, INTERVAL_MS);

  console.log(`[live] watching ${API_URL} every ${INTERVAL_MS / 1000}s`);

  return () => clearInterval(timer);
};
