import { createClient } from "redis";
import type { Config } from "./config.js";
import { linkSchema, type Link, type LinkCache } from "./domain.js";

export function createRedisClient(redisUrl: string) {
  return createClient({
    url: redisUrl,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1000,
    socket: {
      connectTimeout: 1000,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 4), 2000),
    },
  });
}

export type RedisClient = ReturnType<typeof createRedisClient>;
export const cacheKey = (code: string): string => `shortener:v1:${code}`;

export class RedisLinkCache implements LinkCache {
  readonly enabled: boolean;

  constructor(
    private readonly client: RedisClient,
    private readonly config: Pick<Config, "cacheEnabled" | "cacheTtlSeconds" | "redisTimeoutMs">,
  ) {
    this.enabled = config.cacheEnabled;
  }

  private commands() {
    return this.client.withCommandOptions({
      abortSignal: AbortSignal.timeout(this.config.redisTimeoutMs),
    });
  }

  async get(code: string): Promise<Link | null> {
    if (!this.enabled || !this.client.isReady) return null;
    try {
      const value = await this.commands().get(cacheKey(code));
      if (value === null) return null;
      const parsed = linkSchema.safeParse(JSON.parse(value));
      return parsed.success && parsed.data.code === code ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async set(link: Link): Promise<void> {
    if (!this.enabled || !this.client.isReady) return;
    try {
      await this.commands().set(cacheKey(link.code), JSON.stringify(link), {
        EX: this.config.cacheTtlSeconds,
      });
    } catch {
      // Redis is an optimization; committed PostgreSQL writes remain successful.
    }
  }

  async healthy(): Promise<boolean> {
    if (!this.enabled) return true;
    if (!this.client.isReady) return false;
    try {
      return (await this.commands().ping()) === "PONG";
    } catch {
      return false;
    }
  }
}
