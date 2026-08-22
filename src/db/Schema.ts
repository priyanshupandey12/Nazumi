import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, index ,uuid,pgEnum, type AnyPgColumn, integer} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";


export const videoStatusEnum = pgEnum("video_status",["processing","ready","failed"])
export const livestreamStatusEnum = pgEnum("livestream_status", [
  "live",
  "offline",
  "ended",
]);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text("role").default("user"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const video= pgTable("video",{
   id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
   creatorId:text("creator_id").notNull().references(()=>user.id,{onDelete:"cascade"}),
   title:text("title").notNull(),
   description:text("description"),
   thumbnailUrl:text("thumbnail_url"),
   videoUrl:text("video_url"),
   status:videoStatusEnum("status").notNull().default("processing"),
   processingError:text("processing_error"),
   duration: integer("duration"),
   isPublished:boolean("is_published").default(false).notNull(),
   category:text("category"),
   tags:text("tags"),
   viewCount: integer("view_count").default(0).notNull(),
   createdAt: timestamp("created_at").defaultNow().notNull(),
   updatedAt: timestamp("updated_at")
  .defaultNow()
  .$onUpdate(() => new Date())
  .notNull(),
})


export const videoRendition = pgTable("video_rendition",{
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  videoId: uuid("video_id").notNull().references(() => video.id, { onDelete: "cascade" }),

  name: text("name").notNull(),
  height: integer("height").notNull(),
  bandwidth: integer("bandwidth").notNull(),
  playlistUrl: text("playlist_url").notNull(),
  segmentCount: integer("segment_count").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
},
(table) => [index("video_rendition_videoId_idx").on(table.videoId)],
)

export const livestreaming= pgTable("livestreaming",{
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    creatorId:text("creator_id").notNull().references(()=>user.id,{onDelete:"cascade"}),
    title:text("title").notNull(),
    category:text("category"),
    tags:text("tags"),
    streamKey:text("stream_key").notNull(),
    playbackUrl:text("playback_url"),
    status: livestreamStatusEnum("status").default("offline").notNull(),
    viewCount: integer("view_count").default(0).notNull(),
    vodvideoUrl:text("vod_video_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
  .defaultNow()
  .$onUpdate(() => new Date())
  .notNull(),
})


export const chatMessage= pgTable("chat_message",{
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  livestreamId: uuid("livestream_id").notNull().references(() => livestreaming.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})

export const like= pgTable("like",{
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  videoId: uuid("video_id").notNull().references(() => video.id, { onDelete: "cascade" }),
})

export const comment= pgTable("comment",{
 id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),  
 videoId: uuid("video_id").notNull().references(() => video.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
   parentCommentId: uuid("parent_comment_id").references(
    (): AnyPgColumn => comment.id,
    { onDelete: "cascade" }
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})

export const  membership= pgTable("membership",{
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull(),
  razorpaySubscriptionId: text("razorpay_subscription_id").notNull(),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
})

export const subscriber= pgTable("subscriber",{
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  creatorId: text("creator_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  subscriptionDate: timestamp("subscription_date").defaultNow().notNull(),
})

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  videos: many(video),
  livestreams: many(livestreaming),
  chatMessages: many(chatMessage),
  likes: many(like),
  comments: many(comment),
  memberships: many(membership),
  subscriptions: many(subscriber, {
    relationName: "subscriber",
  }),

  subscribers: many(subscriber, {
    relationName: "creator",
  }),
}));

export const videoRelations = relations(video,({one,many})=>({
  creator:one(user,{
    fields:[video.creatorId],
    references:[user.id]
  }),
  likes: many(like),
  comments: many(comment),
  renditions: many(videoRendition)
}))

export const videoRenditionRelations = relations(videoRendition, ({ one }) => ({
  video: one(video, {
    fields: [videoRendition.videoId],
    references: [video.id],
  }),
}));

export const likeRelations = relations(like, ({ one }) => ({
  video: one(video, {
    fields: [like.videoId],
    references: [video.id],
  }),
  user: one(user, {
    fields: [like.userId],
    references: [user.id],
  }),
}));

export const commentRelations = relations(comment, ({ one, many }) => ({
  parent: one(comment, {
    fields: [comment.parentCommentId],
    references: [comment.id],
    relationName: "commentReplies",
  }),

  replies: many(comment, {
    relationName: "commentReplies",
  }),

  user: one(user, {
    fields: [comment.userId],
    references: [user.id],
  }),

  video: one(video, {
    fields: [comment.videoId],
    references: [video.id],
  }),
}));

export const livestreamRelations = relations(livestreaming, ({ one, many }) => ({
  creator: one(user, {
    fields: [livestreaming.creatorId],
    references: [user.id],
  }),
  chatMessages: many(chatMessage)
}))

export const chatMessageRelations = relations(chatMessage, ({ one }) => ({
  livestream: one(livestreaming, {
    fields: [chatMessage.livestreamId],
    references: [livestreaming.id],
  }),

  user: one(user, {
    fields: [chatMessage.userId],
    references: [user.id],
  }),
}));

export const membershipRelations = relations(membership, ({ one }) => ({
  user: one(user, {
    fields: [membership.userId],
    references: [user.id],
  }),

}))

export const subscriberRelations = relations(subscriber, ({ one }) => ({
  subscriber: one(user, {
    fields: [subscriber.userId],
    references: [user.id],
    relationName: "subscriber",
  }),

  creator: one(user, {
    fields: [subscriber.creatorId],
    references: [user.id],
    relationName: "creator",
  }),
}));


export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
