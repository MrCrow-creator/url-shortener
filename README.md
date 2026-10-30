# URL Shortener Service

A standalone URL shortener with a responsive web frontend, a Node.js + Express + TypeScript REST API, PostgreSQL persistence, Redis caching, and a multi-stage Docker build.

## Features

- Web UI for creating custom or generated links, copying results, and viewing recent browser history.
- Cryptographically random eight-character base62 short codes, with collision retries.
- Optional custom codes: 3–32 characters, using letters, digits, `_`, or `-`.
- PostgreSQL primary-key uniqueness, parameterized queries, and persistent Docker storage.
- Redis cache-aside lookups with configurable TTL, bounded command timeouts, and database fallback.
- HTTP(S) URL validation, consistent JSON errors, health endpoints, and graceful shutdown.
- Unit/API tests, real PostgreSQL/Redis integration tests, and a reproducible latency benchmark.

## Start with Docker

Prerequisite: Docker Engine / Docker Desktop with Docker Compose and Linux containers.

Run from this directory:

```sh
docker compose up --build -d --wait
docker compose ps
```

Open **http://localhost:3100** for the frontend. The API runs at the same origin. PostgreSQL and Redis are accessible on the internal Docker network. The first API startup initializes the schema automatically. PostgreSQL data is retained in a named volume across container restarts and rebuilds.

The default credentials are local-development values. To customize configuration, copy `.env.example` to `.env` and edit it before starting. `BASE_URL` is the public origin used in returned short links; update it together with `PORT` when changing the host port. Compose supplies container-internal database and Redis URLs automatically. Use URL-safe characters in `POSTGRES_PASSWORD`, since this Compose configuration embeds it in a connection URL.

```sh
docker compose logs -f api
docker compose restart api
docker compose down
```

`docker compose down` retains stored links. `docker compose down -v` **deletes the PostgreSQL data volume**.

## Docker commands

Docker Hub repository: [infodypiu/url-shortner](https://hub.docker.com/r/infodypiu/url-shortner).

Build and push the frontend/API runtime image from `D:\url-shortener`:

```sh
docker login --username infodypiu
docker build --target runtime -t infodypiu/url-shortner:latest .
docker push infodypiu/url-shortner:latest
```

To push a new tag to this repository, replace `tagname` with your release tag:

```sh
docker tag infodypiu/url-shortner:latest infodypiu/url-shortner:tagname
docker push infodypiu/url-shortner:tagname
```

Pull the published image:

```sh
docker pull infodypiu/url-shortner:latest
```

The image serves the frontend and API on container port `3000` and requires PostgreSQL and Redis configuration. To use it with the supplied Compose stack, set its shared `image` value to `infodypiu/url-shortner:latest`, then run `docker compose up --no-build -d --wait`.

## Use the frontend

Open **http://localhost:3100**, paste a destination URL, optionally choose a custom code, and select **Shorten my link**. Use **Copy link** to share the result. The header displays live service health.

The frontend lives in `public/index.html` and `public/assets/`. Express serves it from the same Docker container as the API. It uses HTML, CSS, and browser JavaScript, with no additional frontend build or server.

The last 20 links created in a browser are stored in that browser's local storage. **Clear history** only clears that local list; PostgreSQL links remain active. If browser storage is blocked, the UI keeps history in memory for the current visit. Clipboard copying works on localhost or HTTPS; otherwise, the UI selects the link for manual copying.

## Try the API

### PowerShell

```powershell
$link = Invoke-RestMethod -Method Post -Uri http://localhost:3100/api/urls `
  -ContentType 'application/json' `
  -Body '{"url":"https://example.com/long/path?campaign=launch","customCode":"launch-2026"}'
$link
Invoke-RestMethod "http://localhost:3100/api/urls/$($link.code)"
curl.exe -I $link.shortUrl
```

### curl (Bash)

```sh
curl -i http://localhost:3100/api/urls \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/long/path?campaign=launch","customCode":"launch-2026"}'

curl -i http://localhost:3100/launch-2026
curl http://localhost:3100/api/urls/launch-2026
curl http://localhost:3100/health
```

Omit `customCode` to generate a random code. Successful creation returns `201 Created`:

```json
{
  "code": "launch-2026",
  "url": "https://example.com/long/path?campaign=launch",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "shortUrl": "http://localhost:3100/launch-2026"
}
```

The timestamp above is illustrative; the database supplies the actual creation time.

| Method        | Endpoint          | Result                               |
| ------------- | ----------------- | ------------------------------------ |
| `POST`        | `/api/urls`       | Create a short link; `201`           |
| `GET`         | `/api/urls/:code` | Link details; `200`                  |
| `GET`, `HEAD` | `/:code`          | Redirect to the original URL; `302`  |
| `GET`         | `/health`         | Dependency readiness; `200` or `503` |
| `GET`         | `/health/live`    | Process liveness; `200`              |

Codes are case-sensitive. `api` and `health` are reserved regardless of case. A duplicate custom code returns `409`; a missing link returns `404`. Invalid input returns `400`, non-JSON creation requests return `415`, and request bodies over 8 KB return `413`. Original URLs are limited to 2,048 characters and normalized with Node's URL parser. Credentials, unsupported schemes, and unescaped whitespace are rejected.

Errors use this shape:

```json
{
  "error": {
    "code": "CODE_TAKEN",
    "message": "This custom code is already in use"
  }
}
```

## Storage and caching

```text
POST /api/urls -> validate -> INSERT PostgreSQL -> best-effort Redis SET -> 201

GET /:code -> Redis GET -- hit -----------------------------> 302
                       -- miss/error -> PostgreSQL SELECT -> Redis SET -> 302
```

- PostgreSQL is the source of truth. Links are immutable through this API.
- Redis stores validated link JSON under `shortener:v1:<code>` with a default one-hour TTL. Creation also warms the cache.
- `X-Cache: HIT`, `MISS`, or `BYPASS` identifies the lookup path. `BYPASS` means caching is disabled; `MISS` also covers Redis failure.
- Redis eviction, expiration, invalid values, or outages fall back to PostgreSQL. Unknown codes are not cached.
- A disconnected Redis client bypasses commands immediately. In-flight cache commands have a default 100 ms timeout. A miss can involve both a cache read and a cache write.
- PostgreSQL failure produces `503` for writes and uncached lookups. Readiness also returns `503`; already cached redirects can still work.
- Redis failure produces `200` readiness with `status: "degraded"`; the service reconnects automatically.
- The Docker runtime uses a non-root user, a read-only filesystem, and production-only dependencies.

## Local development

Requires Node.js 22.13+ and npm. Run these commands from `url-shortener/`:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait postgres redis
npm ci
```

The development override exposes PostgreSQL at `localhost:15432` and Redis at `localhost:16379`. Copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`; Bash: `cp .env.example .env`). Then:

```sh
npm run dev
```

If the containerized API is already occupying port 3100, stop it first with `docker compose stop api`.

| Variable            | Default / requirement                                    |
| ------------------- | -------------------------------------------------------- |
| `PORT`              | `3100` (Compose uses port 3000 inside the API container) |
| `BASE_URL`          | `http://localhost:3100`; HTTP(S) origin without a path   |
| `DATABASE_URL`      | Required for direct Node execution                       |
| `REDIS_URL`         | `redis://localhost:16379`                                |
| `CACHE_ENABLED`     | `true`; set to `false` for the uncached baseline         |
| `CACHE_TTL_SECONDS` | `3600`; range 1–86,400                                   |
| `REDIS_TIMEOUT_MS`  | `100`; range 10–5,000                                    |

Compose also accepts `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `REDIS_PORT`, and `UNCACHED_PORT` overrides. Changing PostgreSQL credentials in `.env` does not rewrite credentials in an already initialized volume.

## Verification

```sh
npm ci
npm run check
docker compose --profile test run --build --rm tests
```

Unit/API tests cover redirects, validation, collisions, missing links, cache behavior, and failure handling. Integration tests use real PostgreSQL and Redis to verify concurrent uniqueness, persistence across app instances, cache-hit database bypass, expiry, corruption recovery, disabled caching, and disconnected-cache fallback. They create uniquely named fixtures and remove only their own rows and keys.

To run integration tests without a test container, set `INTEGRATION_DATABASE_URL` and `INTEGRATION_REDIS_URL`, then run `npm run test:integration`.

Browser checks run against the running Docker service:

```sh
npx playwright install chromium
npm run test:browser
```

These checks exercise creation, clipboard copying, real redirects, duplicate-code errors, browser history, mobile layout, and error handling. A browser test creates one retained short link per run. Override `BROWSER_BASE_URL` for another server, or set `PLAYWRIGHT_CHANNEL=msedge` to use an installed Microsoft Edge browser instead of downloading Chromium.

## Measure caching performance

The benchmark compares two instances of the same API sharing one database: Redis-enabled on port 3100 and cache-disabled on port 3101. It verifies every response's `Location` and `X-Cache` headers, warms both instances, alternates measurement order across rounds, and reports mean, p50, and p95 end-to-end HTTP latency.

```sh
docker compose --profile benchmark up --build -d --wait
npm run benchmark
```

Without a local Node installation:

```sh
docker compose exec -e CACHED_BASE_URL=http://api:3000 -e UNCACHED_BASE_URL=http://api-uncached:3000 api node scripts/benchmark.js
```

Defaults: 5 rounds × 1,000 sequential requests per instance, with 100 warm-up requests per instance. Override `BENCHMARK_ROUNDS`, `BENCHMARK_REQUESTS`, `BENCHMARK_WARMUP`, `CACHED_BASE_URL`, or `UNCACHED_BASE_URL` through environment variables. Each run creates one retained benchmark link.

```text
latency reduction (%) = (uncached mean - cached mean) / uncached mean × 100
```

**A 60% reduction is a measurement target, not a guaranteed result.** Small local indexed PostgreSQL lookups can be nearly as fast as Redis, and HTTP/network overhead can dominate. This single-hot-link benchmark is not a capacity test or a mixed-workload production benchmark. Report the actual measured improvement and workload rather than claiming an unverified percentage.

One verification run on a Windows host with Docker Desktop Linux containers and a Node.js 22 client produced the following results using the default workload (5,000 measured requests per instance):

| Lookup path                | Mean latency | p95 latency |
| -------------------------- | ------------ | ----------- |
| Redis cache hit            | 5.757 ms     | 9.079 ms    |
| PostgreSQL, cache disabled | 6.235 ms     | 9.589 ms    |

The observed mean latency reduction was **7.65%** for that run. The script reports fresh measurements on every execution.

Stop the optional baseline with `docker compose --profile benchmark stop api-uncached`. To stop the whole stack, including the baseline, use `docker compose --profile benchmark down`.
