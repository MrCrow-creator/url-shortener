import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { ZodError } from "zod";
import { codeSchema, createUrlSchema, HttpError, type Link } from "./domain.js";
import type { UrlService } from "./service.js";

export function createApp(service: UrlService, baseUrl: string) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "connect-src": ["'self'"],
          // The local Docker deployment is served over HTTP.
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "8kb" }));

  app.get("/", (_req, res) => {
    res.sendFile(fileURLToPath(new URL("../public/index.html", import.meta.url)), {
      cacheControl: false,
    });
  });
  app.use(
    "/assets",
    express.static(fileURLToPath(new URL("../public/assets/", import.meta.url)), {
      index: false,
      redirect: false,
      etag: false,
      cacheControl: false,
    }),
  );

  const present = (link: Link) => ({ ...link, shortUrl: `${baseUrl}/${link.code}` });

  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/health", async (_req, res) => {
    const health = await service.health();
    res.status(health.postgres === "up" ? 200 : 503).json(health);
  });

  app.post("/api/urls", async (req, res) => {
    if (!req.is("application/json")) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use Content-Type: application/json");
    }
    const input = createUrlSchema.parse(req.body);
    const link = await service.create(input.url, input.customCode);
    res.status(201).location(`${baseUrl}/api/urls/${link.code}`).json(present(link));
  });

  app.get("/api/urls/:code", async (req, res) => {
    const code = codeSchema.parse(req.params.code);
    const { link, cacheStatus } = await service.resolve(code);
    res.set("X-Cache", cacheStatus).json(present(link));
  });

  app.get("/:code", async (req, res) => {
    const parsed = codeSchema.safeParse(req.params.code);
    if (!parsed.success) throw new HttpError(404, "LINK_NOT_FOUND", "Short link not found");
    const { link, cacheStatus } = await service.resolve(parsed.data);
    res.set("X-Cache", cacheStatus).redirect(302, link.url);
  });

  app.use((_req, _res, next) => {
    next(new HttpError(404, "NOT_FOUND", "Route not found"));
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "Request validation failed",
          details: error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    const type = error && typeof error === "object" && "type" in error ? error.type : null;
    if (type === "entity.parse.failed" || error instanceof URIError) {
      res
        .status(400)
        .json({ error: { code: "INVALID_REQUEST", message: "Malformed JSON or URL" } });
      return;
    }
    if (type === "entity.too.large") {
      res
        .status(413)
        .json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request exceeds 8 KB" } });
      return;
    }
    console.error("Unhandled request error", error instanceof Error ? error.name : "UnknownError");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  };
  app.use(errorHandler);
  return app;
}
