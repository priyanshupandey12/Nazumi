import { user } from "../db/Schema.js";

/**
 * How a person is shown anywhere in the app.
 *
 * Channel identity overrides the Google-sourced values, but only when it is
 * actually set — an empty display name falls back rather than rendering a
 * nameless channel.
 *
 * Resolved in JS rather than a SQL `coalesce` on purpose: inside a `select()`
 * drizzle renders columns unqualified, so a coalesce over a joined `name`
 * silently binds to whichever table the planner picks first.
 */
export const identityColumns = {
  id: user.id,
  name: user.name,
  image: user.image,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
};

export type IdentityRow = {
  id: string;
  name: string | null;
  image: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type PublicIdentity = {
  id: string;
  name: string;
  image: string | null;
};

export const toPublicIdentity = (row: IdentityRow): PublicIdentity => ({
  id: row.id,
  name: row.displayName?.trim() || row.name?.trim() || "Unknown creator",
  image: row.avatarUrl?.trim() || row.image || null,
});

/** The same resolution for rows read through a join with aliased columns. */
export const resolveIdentity = (parts: {
  id: string;
  name: string | null;
  image: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}): PublicIdentity => toPublicIdentity(parts);
