CREATE TYPE "public"."caption_source" AS ENUM('uploaded', 'embedded');--> statement-breakpoint
CREATE TABLE "video_caption" (
	"id" uuid PRIMARY KEY NOT NULL,
	"video_id" uuid NOT NULL,
	"language" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"source" "caption_source" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_caption" ADD CONSTRAINT "video_caption_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_caption_videoId_idx" ON "video_caption" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_caption_video_language_idx" ON "video_caption" USING btree ("video_id","language");