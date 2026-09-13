ALTER TABLE "like" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "comment_videoId_idx" ON "comment" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "comment_parentCommentId_idx" ON "comment" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "like_user_video_idx" ON "like" USING btree ("user_id","video_id");--> statement-breakpoint
CREATE INDEX "like_videoId_idx" ON "like" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriber_user_creator_idx" ON "subscriber" USING btree ("user_id","creator_id");--> statement-breakpoint
CREATE INDEX "subscriber_creatorId_idx" ON "subscriber" USING btree ("creator_id");