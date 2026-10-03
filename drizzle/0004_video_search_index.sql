-- Backs `GET /api/videos?q=`, which matches title, description and tags as one
-- document. The expression here must stay identical to `searchDocument` in
-- src/controller/video.controller.ts or Postgres will not use the index.
CREATE INDEX IF NOT EXISTS "video_search_idx" ON "video" USING gin (
  to_tsvector(
    'english',
    coalesce("title", '') || ' ' ||
    coalesce("description", '') || ' ' ||
    coalesce("tags", '')
  )
);--> statement-breakpoint
-- Category browsing filters on a case-insensitive exact match.
CREATE INDEX IF NOT EXISTS "video_category_idx" ON "video" (lower("category"));
