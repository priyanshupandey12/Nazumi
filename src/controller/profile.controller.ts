import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { user } from "../db/Schema.js";
import { currentUser } from "../lib/access.js";
import { toPublicIdentity } from "../lib/identity.js";
import {
  deleteFromCloudinary,
  publicIdFromUrl,
  uploadToCloudinary,
} from "../utils/cloudinary.js";

/*

  Client
  |
  | GET /me          PATCH /me  { displayName?, bio?, avatarUrl? }
  v
Own row only
  |
  +---- New avatar -> Cloudinary, old one removed after the write
  |
  v
{ profile }

*/

const MAX_DISPLAY_NAME = 50;
const MAX_BIO = 500;

const loadProfile = async (userId: string) => {
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!row) return null;

  const identity = toPublicIdentity(row);

  return {
    id: row.id,
    email: row.email,
    // What the rest of the app shows.
    name: identity.name,
    image: identity.image,
    // The raw values, so the editor can tell "set" from "inherited".
    displayName: row.displayName,
    bio: row.bio,
    avatarUrl: row.avatarUrl,
    accountName: row.name,
    accountImage: row.image,
    createdAt: row.createdAt,
  };
};

const getMe = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const profile = await loadProfile(viewer.id);

  if (!profile) {
    return res.status(404).json({ message: "Profile not found" });
  }

  return res.json({ profile });
};

const updateMe = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const existing = await loadProfile(viewer.id);

  if (!existing) {
    return res.status(404).json({ message: "Profile not found" });
  }

  const { displayName, bio, avatarUrl } = req.body ?? {};
  const patch: Partial<typeof user.$inferInsert> = {};

  if (typeof displayName === "string") {
    const trimmed = displayName.trim();
    if (trimmed.length > MAX_DISPLAY_NAME) {
      return res.status(400).json({
        message: `A channel name can be at most ${MAX_DISPLAY_NAME} characters`,
      });
    }
    // Clearing it falls back to the account name rather than leaving a blank.
    patch.displayName = trimmed || null;
  }

  if (typeof bio === "string") {
    const trimmed = bio.trim();
    if (trimmed.length > MAX_BIO) {
      return res
        .status(400)
        .json({ message: `A bio can be at most ${MAX_BIO} characters` });
    }
    patch.bio = trimmed || null;
  }

  let replacedAvatar = false;

  if (typeof avatarUrl === "string" && avatarUrl.startsWith("data:image")) {
    try {
      const uploaded = await uploadToCloudinary(avatarUrl, "avatars");
      patch.avatarUrl = uploaded.secure_url;
      replacedAvatar = true;
    } catch (error) {
      console.error(`[profile] avatar upload failed for ${viewer.id}:`, error);
      return res
        .status(502)
        .json({ message: "Could not store that picture. Please try again." });
    }
  } else if (avatarUrl === null) {
    patch.avatarUrl = null;
    replacedAvatar = true;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ message: "No supported fields to update" });
  }

  await db.update(user).set(patch).where(eq(user.id, viewer.id));

  // Only after the row is written: losing the old picture on a failed update
  // would leave the channel with a dead image.
  if (replacedAvatar && existing.avatarUrl) {
    const publicId = publicIdFromUrl(existing.avatarUrl);
    if (publicId) {
      await deleteFromCloudinary(publicId).catch((error) => {
        console.error(`[profile] old avatar cleanup failed:`, error);
      });
    }
  }

  return res.json({ profile: await loadProfile(viewer.id) });
};

export { getMe, updateMe };
