import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../dist/config.js";

const base = { DATABASE_URL: "postgresql://user:password@localhost/shortener" };

test("configuration parses explicit cache disabling and normalizes the public origin", () => {
  const config = loadConfig({
    ...base,
    CACHE_ENABLED: "false",
    BASE_URL: "https://sho.rt/",
    CACHE_TTL_SECONDS: "60",
  });
  assert.equal(config.cacheEnabled, false);
  assert.equal(config.baseUrl, "https://sho.rt");
  assert.equal(config.cacheTtlSeconds, 60);
});

test("configuration rejects bad ports, TTLs, URL schemes, and public base paths", () => {
  for (const override of [
    { PORT: "not-a-port" },
    { PORT: "70000" },
    { CACHE_TTL_SECONDS: "0" },
    { CACHE_ENABLED: "yes" },
    { DATABASE_URL: "http://localhost" },
    { REDIS_URL: "http://localhost" },
    { BASE_URL: "https://sho.rt/path" },
    { BASE_URL: "https://user:password@sho.rt" },
    { BASE_URL: "ftp://sho.rt" },
  ]) {
    assert.throws(() => loadConfig({ ...base, ...override }));
  }
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});
