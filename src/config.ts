import { z } from "zod";

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  BASE_URL: z.url().default("http://localhost:3100"),
  DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:\/\//.test(value)),
  REDIS_URL: z.url().default("redis://localhost:16379"),
  CACHE_ENABLED: z.enum(["true", "false"]).default("true"),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(3600),
  REDIS_TIMEOUT_MS: z.coerce.number().int().min(10).max(5000).default(100),
});

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${fields}`);
  }

  const env = result.data;
  const baseUrl = new URL(env.BASE_URL);
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("BASE_URL must be an HTTP(S) origin without credentials, a path, or a query");
  }
  if (!["redis:", "rediss:"].includes(new URL(env.REDIS_URL).protocol)) {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }

  return {
    port: env.PORT,
    baseUrl: baseUrl.origin,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    cacheEnabled: env.CACHE_ENABLED === "true",
    cacheTtlSeconds: env.CACHE_TTL_SECONDS,
    redisTimeoutMs: env.REDIS_TIMEOUT_MS,
  };
}

export type Config = ReturnType<typeof loadConfig>;
