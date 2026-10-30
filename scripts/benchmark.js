import { performance } from "node:perf_hooks";

const cachedBase = (process.env.CACHED_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const uncachedBase = (process.env.UNCACHED_BASE_URL ?? "http://localhost:3101").replace(/\/$/, "");
const requests = Number(process.env.BENCHMARK_REQUESTS ?? 1000);
const rounds = Number(process.env.BENCHMARK_ROUNDS ?? 5);
const warmup = Number(process.env.BENCHMARK_WARMUP ?? 100);

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    requests: samples.length,
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

async function redirect(base, code, expectedCache, expectedUrl) {
  const start = performance.now();
  const response = await fetch(`${base}/${code}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  await response.arrayBuffer();
  const duration = performance.now() - start;
  if (
    response.status !== 302 ||
    response.headers.get("x-cache") !== expectedCache ||
    response.headers.get("location") !== expectedUrl
  ) {
    throw new Error(
      `Expected a correct 302 with X-Cache: ${expectedCache} from ${base}; ` +
        `received ${response.status}, X-Cache: ${response.headers.get("x-cache")}`,
    );
  }
  return duration;
}

async function main() {
  if (![requests, rounds, warmup].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error(
      "BENCHMARK_REQUESTS, BENCHMARK_ROUNDS, and BENCHMARK_WARMUP must be positive integers",
    );
  }
  if (cachedBase === uncachedBase)
    throw new Error("Use separate cached and cache-disabled API URLs");

  const created = await fetch(`${cachedBase}/api/urls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/benchmark" }),
    signal: AbortSignal.timeout(5000),
  });
  if (created.status !== 201) throw new Error(`Could not create benchmark link: ${created.status}`);
  const link = await created.json();
  const targets = [
    { name: "cached", base: cachedBase, header: "HIT", samples: [] },
    { name: "uncached", base: uncachedBase, header: "BYPASS", samples: [] },
  ];
  for (let index = 0; index < warmup; index++) {
    for (const target of targets) await redirect(target.base, link.code, target.header, link.url);
  }
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? targets : [...targets].reverse();
    for (const target of order) {
      for (let index = 0; index < requests; index++) {
        target.samples.push(await redirect(target.base, link.code, target.header, link.url));
      }
    }
  }

  const cached = stats(targets[0].samples);
  const uncached = stats(targets[1].samples);
  console.log(
    JSON.stringify(
      {
        workload: "Sequential HTTP redirects to one hot link; complete responses; concurrency=1",
        rounds,
        requestsPerRound: requests,
        warmupPerTarget: warmup,
        cachedBase,
        uncachedBase,
        code: link.code,
        cached,
        uncached,
        meanLatencyReductionPercent: ((uncached.meanMs - cached.meanMs) / uncached.meanMs) * 100,
        note: "Measured locally, not a guaranteed speedup. Negative reduction means caching was slower.",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
