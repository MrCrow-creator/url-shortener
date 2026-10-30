import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../../dist/app.js";
import { UrlService } from "../../dist/service.js";

function fixture(nextCode) {
  const rows = new Map();
  const cached = new Map();
  const store = {
    reads: 0,
    async insert(code, url) {
      if (rows.has(code)) return null;
      const link = { code, url, createdAt: new Date().toISOString() };
      rows.set(code, link);
      return link;
    },
    async find(code) {
      this.reads++;
      return rows.get(code) ?? null;
    },
    async healthy() {
      return true;
    },
  };
  const cache = {
    enabled: true,
    async get(code) {
      return cached.get(code) ?? null;
    },
    async set(link) {
      cached.set(link.code, link);
    },
    async healthy() {
      return true;
    },
  };
  const service = new UrlService(store, cache, nextCode);
  return {
    app: createApp(service, "https://sho.rt"),
    service,
    rows,
    cached,
    store,
    cache,
  };
}

test("create an automatic code and redirect to the persisted URL", async () => {
  const { app, rows } = fixture();
  const created = await request(app)
    .post("/api/urls")
    .set("Host", "untrusted.example")
    .send({ url: "https://example.com/article?ref=1#section" })
    .expect(201);
  assert.match(created.body.code, /^[A-Za-z0-9]{8}$/);
  assert.equal(created.body.shortUrl, `https://sho.rt/${created.body.code}`);
  assert.equal(created.headers.location, `https://sho.rt/api/urls/${created.body.code}`);
  assert.equal(rows.get(created.body.code).url, created.body.url);
  await request(app)
    .get(`/${created.body.code}`)
    .expect(302)
    .expect("Location", "https://example.com/article?ref=1#section")
    .expect("X-Cache", "HIT")
    .expect("Cache-Control", "no-store");
});

test("frontend assets coexist with a short code named assets", async () => {
  const { app } = fixture();
  await request(app).get("/").expect(200).expect("Content-Type", /html/);
  await request(app)
    .get("/assets/app.js")
    .expect(200)
    .expect("Content-Type", /javascript/);
  await request(app).get("/assets/styles.css").expect(200).expect("Content-Type", /css/);
  await request(app)
    .post("/api/urls")
    .send({ url: "https://example.com/assets", customCode: "assets" })
    .expect(201);
  await request(app).get("/assets").expect(302).expect("Location", "https://example.com/assets");
  await request(app).get("/assets/missing.js").expect(404);
});

test("custom codes are case-sensitive and duplicates cannot overwrite links", async () => {
  const { app } = fixture();
  await request(app)
    .post("/api/urls")
    .send({ url: "https://example.com/first", customCode: "Launch_2026" })
    .expect(201);
  const duplicate = await request(app)
    .post("/api/urls")
    .send({ url: "https://example.com/second", customCode: "Launch_2026" })
    .expect(409);
  assert.equal(duplicate.body.error.code, "CODE_TAKEN");
  await request(app)
    .get("/Launch_2026")
    .expect(302)
    .expect("Location", "https://example.com/first");
  await request(app).get("/launch_2026").expect(404);
});

test("cache misses populate Redis and later hits skip the database", async () => {
  const { app, cached, store } = fixture();
  const created = await request(app).post("/api/urls").send({ url: "https://example.com" });
  cached.clear();
  await request(app).get(`/${created.body.code}`).expect(302).expect("X-Cache", "MISS");
  assert.equal(store.reads, 1);
  const metadata = await request(app)
    .get(`/api/urls/${created.body.code}`)
    .expect(200)
    .expect("X-Cache", "HIT");
  assert.equal(metadata.body.url, "https://example.com/");
  assert.equal(store.reads, 1);
});

test("generated-code collisions retry without replacing the original row", async () => {
  const codes = ["collision", "collision", "freshCode"];
  const { service, rows } = fixture(() => codes.shift());
  await service.create("https://example.com/old");
  const link = await service.create("https://example.com/new");
  assert.equal(link.code, "freshCode");
  assert.equal(rows.get("collision").url, "https://example.com/old");
});

test("code generation stops after five collisions", async () => {
  const { service } = fixture(() => "collision");
  await service.create("https://example.com/old");
  await assert.rejects(service.create("https://example.com/new"), {
    status: 503,
    code: "CODE_GENERATION_FAILED",
  });
});

test("invalid URLs, custom codes, and unexpected fields are rejected", async (t) => {
  const { app, rows } = fixture();
  const invalid = [
    {},
    { url: "javascript:alert(1)" },
    { url: "ftp://example.com/file" },
    { url: "/relative" },
    { url: "https://" },
    { url: "https://user:password@example.com" },
    { url: "https://example.com/a\r\nInjected: value" },
    { url: "https://example.com/a b" },
    { url: `https://example.com/${"x".repeat(2048)}` },
    { url: "https://example.com", customCode: "ab" },
    { url: "https://example.com", customCode: "a".repeat(33) },
    { url: "https://example.com", customCode: "with/slash" },
    { url: "https://example.com", customCode: "HeAlTh" },
    { url: "https://example.com", customCode: "api" },
    { url: "https://example.com", customCode: "' OR 1=1--" },
    { url: "https://example.com", unexpected: true },
  ];
  for (const [index, body] of invalid.entries()) {
    await t.test(`invalid input ${index + 1}`, async () => {
      const response = await request(app).post("/api/urls").send(body).expect(400);
      assert.equal(response.body.error.code, "INVALID_INPUT");
    });
  }
  assert.equal(rows.size, 0);
});

test("malformed JSON, oversized bodies, and wrong content types return JSON errors", async () => {
  const { app } = fixture();
  await request(app)
    .post("/api/urls")
    .set("Content-Type", "application/json")
    .send('{"url":')
    .expect(400)
    .expect("Content-Type", /json/);
  await request(app)
    .post("/api/urls")
    .send({ url: "x".repeat(9000) })
    .expect(413);
  await request(app).post("/api/urls").type("text").send("hello").expect(415);
});

test("unknown links return 404 and are not cached", async () => {
  const { app, cached } = fixture();
  const response = await request(app).get("/notFound").expect(404);
  assert.equal(response.body.error.code, "LINK_NOT_FOUND");
  await request(app).get("/api/urls/notFound").expect(404);
  await request(app).get("/invalid/route/path").expect(404);
  assert.equal(cached.size, 0);
});

test("storage outages return 503 without exposing database details", async () => {
  const { app, store } = fixture();
  const fail = async () => {
    throw new Error("database password=secret");
  };
  store.insert = fail;
  store.find = fail;
  const created = await request(app)
    .post("/api/urls")
    .send({ url: "https://example.com" })
    .expect(503);
  const lookup = await request(app).get("/someCode").expect(503);
  assert.equal(created.body.error.code, "STORAGE_UNAVAILABLE");
  assert.ok(!lookup.text.includes("secret"));
});

test("readiness requires PostgreSQL but accepts a degraded Redis cache", async () => {
  const { app, store, cache } = fixture();
  await request(app).get("/health").expect(200);
  cache.healthy = async () => false;
  const degraded = await request(app).get("/health").expect(200);
  assert.equal(degraded.body.status, "degraded");
  assert.equal(degraded.body.redis, "down");
  store.healthy = async () => false;
  await request(app).get("/health").expect(503);
  await request(app).get("/health/live").expect(200);
});
