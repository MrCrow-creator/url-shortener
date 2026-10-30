import { generateCode, HttpError, type Link, type LinkCache, type LinkStore } from "./domain.js";

export class UrlService {
  constructor(
    private readonly store: LinkStore,
    private readonly cache: LinkCache,
    private readonly nextCode: () => string = generateCode,
  ) {}

  async create(url: string, customCode?: string): Promise<Link> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = customCode ?? this.nextCode();
      let link: Link | null;
      try {
        link = await this.store.insert(code, url);
      } catch {
        throw new HttpError(503, "STORAGE_UNAVAILABLE", "Link storage is temporarily unavailable");
      }
      if (link) {
        await this.cache.set(link);
        return link;
      }
      if (customCode) {
        throw new HttpError(409, "CODE_TAKEN", "This custom code is already in use");
      }
    }
    throw new HttpError(503, "CODE_GENERATION_FAILED", "Unable to allocate a code; please retry");
  }

  async resolve(code: string) {
    const cached = await this.cache.get(code);
    if (cached) return { link: cached, cacheStatus: "HIT" } as const;

    let link: Link | null;
    try {
      link = await this.store.find(code);
    } catch {
      throw new HttpError(503, "STORAGE_UNAVAILABLE", "Link storage is temporarily unavailable");
    }
    if (!link) throw new HttpError(404, "LINK_NOT_FOUND", "Short link not found");
    await this.cache.set(link);
    return { link, cacheStatus: this.cache.enabled ? "MISS" : "BYPASS" } as const;
  }

  async health() {
    const [postgres, redis] = await Promise.all([this.store.healthy(), this.cache.healthy()]);
    return {
      status: !postgres ? "unavailable" : redis ? "ok" : "degraded",
      postgres: postgres ? "up" : "down",
      redis: !this.cache.enabled ? "disabled" : redis ? "up" : "down",
    };
  }
}
