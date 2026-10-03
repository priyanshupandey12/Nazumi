# tests

Vitest, with the API driven in-process through supertest. No server needs to be
running — `createApp()` is imported directly, which is why `src/index.ts` now
only binds the port.

## Running them

```bash
pnpm test          # once
pnpm test:watch    # on change
```

Postgres and Redis must be up:

```bash
docker start streamhub nazumi
```

## First-time setup

Tests use their own database so a run can never touch development data:

```bash
docker exec streamhub psql -U postgres -c "CREATE DATABASE streamhub_test"
pnpm test:migrate
```

Re-run `pnpm test:migrate` after adding a migration — the test database is not
migrated automatically.

## How isolation works

- `.env.test` points `DATABASE_URL` at `streamhub_test` and Redis at index 1.
  `vitest.config.ts` loads it into `process.env` *before* any source module is
  imported, so the `dotenv/config` calls inside `src/` find the variables
  already set and leave them alone — dotenv never overwrites.
- `tests/setup.ts` refuses to run at all unless `DATABASE_URL` names the test
  database, then truncates every table before each test.
- Cloudinary is mocked globally in `tests/setup.ts`. It is a paid external
  service and the delete path would otherwise issue real requests.
- ffmpeg is never invoked. The worker is not started; upload tests only queue a
  job, and the transcode ladder and playlist rewriting are covered as units.

## Layout

| File | Covers |
| --- | --- |
| `api/upload.test.ts` | Auth, required fields, and the multer guards — oversized thumbnails, wrong mime types, JSON error shapes |
| `api/videos.test.ts` | Feed visibility, cursor pagination, search, filters, detail enrichment, status error scoping, edit, delete + cascade |
| `api/engagement.test.ts` | Likes, comment threading and moderation, subscriptions, the following feed, view counting |
| `api/discovery.test.ts` | Category counts and related-video ranking |
| `unit/ffmpeg.test.ts` | Rendition ladder selection |
| `unit/hls.upload.test.ts` | Playlist rewriting, progress reporting, failure modes |

## Writing a new one

`tests/helpers.ts` has `createUser()` (returns a signed session cookie),
`createVideo()` and `createVideos()`. Prefer driving the HTTP API over calling
controllers directly — the middleware chain is part of the behaviour, and the
upload guards live there rather than in the controller.
