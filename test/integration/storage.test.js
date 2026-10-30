import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../../dist/app.js";
import { cacheKey, createRedisClient, RedisLinkCache } from "../../dist/cache.js";
import { UrlService } from "../../dist/service.js";
import { createPool, migrate, PostgresLinkStore } from "../../dist/store.js";

test("PostgreSQL and Redis integration", { timeout: 30000 }, async (t) => {
  assert.ok(
    process.env.INTEGRATION_DATABASE_URL,
    "Set INTEGRATION_DATABASE_URL or use Docker tests",
  );
  assert.ok(process.env.INTEGRATION_REDIS_URL, "Set INTEGRATION_REDIS_URL or use Docker tests");
  const pool = createPool(process.env.INTEGRATION_DATABASE_URL);
  const redis = createRedisClient(process.env.INTEGRATION_REDIS_URL);
  redis.on("error", () => {});
  const codes = new Set();
  const prefix = `it_${randomBytes(6).toString("hex")}`;
  const code = (suffix) => {
    const value = `${prefix}_${suffix}`;
    codes.add(value);
    return value;
  };
  t.after(async () => {
    try {
      if (codes.size) {
        await pool.query("DELETE FROM short_urls WHERE code = ANY($1::varchar[])", [[...codes]]);
        if (redis.isReady) await redis.del([...codes].map(cacheKey));
      }
    } finally {
      if (redis.isOpen) redis.destroy();
      await pool.end();
    }
  });
  await migrate(pool);
  await redis.connect();
  const config = { cacheEnabled: true, cacheTtlSeconds: 30, redisTimeoutMs: 500 };
  const store = new PostgresLinkStore(pool);
  const cache = new RedisLinkCache(redis, config);
  const app = createApp(new UrlService(store, cache), "https://sho.rt");

  await t.test("records persist across app instances and cache misses refill Redis", async () => {
    const customCode = code("persist");
    const url = "https://example.com/O'Reilly?query=book";
    await request(app).post("/api/urls").send({ url, customCode }).expect(201);
    const persisted = await pool.query("SELECT original_url FROM short_urls WHERE code = $1", [
      customCode,
    ]);
    assert.equal(persisted.rows[0].original_url, url);
    await redis.del(cacheKey(customCode));

    let databaseReads = 0;
    const countingStore = {
      insert: store.insert.bind(store),
      healthy: store.healthy.bind(store),
      async find(value) {
        databaseReads++;
        return store.find(value);
      },
    };
    const restartedApp = createApp(new UrlService(countingStore, cache), "https://sho.rt");
    await request(restartedApp)
      .get(`/${customCode}`)
      .expect(302)
      .expect("Location", url)
      .expect("X-Cache", "MISS");
    await request(restartedApp).get(`/${customCode}`).expect(302).expect("X-Cache", "HIT");
    assert.equal(databaseReads, 1);
    const ttl = await redis.ttl(cacheKey(customCode));
    assert.ok(ttl > 0 && ttl <= config.cacheTtlSeconds);
  });

  await t.test("concurrent custom-code requests have exactly one winner", async () => {
    const customCode = code("race");
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        request(app)
          .post("/api/urls")
          .send({ url: `https://example.com/${index}`, customCode }),
      ),
    );
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.equal(responses.filter((response) => response.status === 409).length, 9);
    const winner = responses.find((response) => response.status === 201);
    assert.equal((await store.find(customCode)).url, winner.body.url);
    await request(app).get(`/${customCode}`).expect(302).expect("Location", winner.body.url);
  });

  await t.test("expired Redis entries reload from PostgreSQL", async () => {
    const customCode = code("ttl");
    const shortCache = new RedisLinkCache(redis, { ...config, cacheTtlSeconds: 1 });
    const shortApp = createApp(new UrlService(store, shortCache), "https://sho.rt");
    await request(shortApp)
      .post("/api/urls")
      .send({ url: "https://example.com/ttl", customCode })
      .expect(201);
    await setTimeout(1100);
    assert.equal(await redis.exists(cacheKey(customCode)), 0);
    await request(shortApp).get(`/${customCode}`).expect(302).expect("X-Cache", "MISS");
    assert.equal(await redis.exists(cacheKey(customCode)), 1);
  });

  await t.test("corrupt cache data is repaired from the persisted record", async () => {
    const customCode = code("corrupt");
    await request(app)
      .post("/api/urls")
      .send({ url: "https://example.com/correct", customCode })
      .expect(201);
    await redis.set(cacheKey(customCode), "invalid JSON");
    await request(app)
      .get(`/${customCode}`)
      .expect(302)
      .expect("X-Cache", "MISS")
      .expect("Location", "https://example.com/correct");
    assert.equal(
      JSON.parse(await redis.get(cacheKey(customCode))).url,
      "https://example.com/correct",
    );
  });

  await t.test("cache-disabled mode reads PostgreSQL and leaves Redis untouched", async () => {
    const customCode = code("bypass");
    const disabledCache = new RedisLinkCache(redis, { ...config, cacheEnabled: false });
    const uncached = createApp(new UrlService(store, disabledCache), "https://sho.rt");
    await request(uncached)
      .post("/api/urls")
      .send({ url: "https://example.com/bypass", customCode })
      .expect(201);
    await request(uncached).get(`/${customCode}`).expect(302).expect("X-Cache", "BYPASS");
    assert.equal(await redis.exists(cacheKey(customCode)), 0);
  });

  await t.test("a disconnected Redis client still allows creation and redirects", async () => {
    const customCode = code("offline");
    redis.destroy();
    try {
      await request(app)
        .post("/api/urls")
        .send({ url: "https://example.com/offline", customCode })
        .expect(201);
      await request(app)
        .get(`/${customCode}`)
        .expect(302)
        .expect("Location", "https://example.com/offline");
      const response = await request(app).get("/health").expect(200);
      assert.equal(response.body.status, "degraded");
    } finally {
      await redis.connect();
    }
  });
});
