import "dotenv/config";
import { createApp } from "./app.js";
import { createRedisClient, RedisLinkCache } from "./cache.js";
import { loadConfig } from "./config.js";
import { UrlService } from "./service.js";
import { createPool, migrate, PostgresLinkStore } from "./store.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  pool.on("error", () => console.error("PostgreSQL pool connection failed"));
  try {
    await migrate(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  const redis = createRedisClient(config.redisUrl);
  redis.on("error", () => console.warn("Redis unavailable; using PostgreSQL fallback"));
  if (config.cacheEnabled) {
    // Start even during a cache outage; the client reconnects in the background.
    void redis.connect().catch(() => console.warn("Redis connection failed"));
  }

  const service = new UrlService(new PostgresLinkStore(pool), new RedisLinkCache(redis, config));
  const server = createApp(service, config.baseUrl).listen(config.port, "0.0.0.0", () => {
    console.log(`URL shortener listening on port ${config.port}; public URL: ${config.baseUrl}`);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    server.close(() => {
      if (redis.isOpen) redis.destroy();
      void pool.end().finally(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("error", (error) => {
    console.error("HTTP server failed:", error.message);
    if (redis.isOpen) redis.destroy();
    void pool.end().finally(() => process.exit(1));
  });
}

main().catch((error: unknown) => {
  console.error("Startup failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
