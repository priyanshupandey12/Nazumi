CREATE TABLE "video_rendition" (
	"id" uuid PRIMARY KEY NOT NULL,
	"video_id" uuid NOT NULL,
	"name" text NOT NULL,
	"height" integer NOT NULL,
	"bandwidth" integer NOT NULL,
	"playlist_url" text NOT NULL,
	"segment_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_rendition" ADD CONSTRAINT "video_rendition_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_rendition_videoId_idx" ON "video_rendition" USING btree ("video_id");--> statement-breakpoint
ALTER TABLE "video" RENAME COLUMN "processing" TO "status";--> statement-breakpoint
ALTER TABLE "video" ALTER COLUMN "video_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "processing_error" text;
