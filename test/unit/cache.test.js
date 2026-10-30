import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheKey, RedisLinkCache } from "../../dist/cache.js";

const config = { cacheEnabled: true, cacheTtlSeconds: 60, redisTimeoutMs: 25 };
const link = {
  code: "sampleCode",
  url: "https://example.com/",
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("cache writes use a namespaced key and the configured TTL", async () => {
  let argumentsReceived;
  const client = {
    isReady: true,
    withCommandOptions(options) {
      assert.ok(options.abortSignal instanceof AbortSignal);
      return {
        async set(...args) {
          argumentsReceived = args;
        },
      };
    },
  };
  await new RedisLinkCache(client, config).set(link);
  assert.deepEqual(argumentsReceived, [cacheKey(link.code), JSON.stringify(link), { EX: 60 }]);
});

test("corrupt, mismatched, and unsafe cache entries are treated as misses", async () => {
  for (const value of [
    "not json",
    JSON.stringify({ ...link, code: "anotherCode" }),
    JSON.stringify({ ...link, url: "javascript:alert(1)" }),
    JSON.stringify({ code: link.code }),
    "null",
  ]) {
    const client = {
      isReady: true,
      withCommandOptions: () => ({ get: async () => value }),
    };
    assert.equal(await new RedisLinkCache(client, config).get(link.code), null);
  }
});

test("Redis command failures degrade to misses and do not reject writes", async () => {
  const fail = async () => {
    throw new Error("Redis connection reset");
  };
  const client = {
    isReady: true,
    withCommandOptions: () => ({ get: fail, set: fail, ping: fail }),
  };
  const cache = new RedisLinkCache(client, config);
  assert.equal(await cache.get(link.code), null);
  await cache.set(link);
  assert.equal(await cache.healthy(), false);
});

test("disabled or disconnected caches do not issue Redis commands", async () => {
  const client = {
    isReady: false,
    withCommandOptions() {
      assert.fail("Unexpected Redis command");
    },
  };
  const offline = new RedisLinkCache(client, config);
  assert.equal(await offline.get(link.code), null);
  await offline.set(link);
  client.isReady = true;
  const disabled = new RedisLinkCache(client, { ...config, cacheEnabled: false });
  assert.equal(await disabled.get(link.code), null);
  await disabled.set(link);
  assert.equal(await disabled.healthy(), true);
});
