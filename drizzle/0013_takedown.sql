ALTER TYPE "public"."notification_type" ADD VALUE 'video_takedown';--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "takedown_reason" text;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "takedown_at" timestamp;