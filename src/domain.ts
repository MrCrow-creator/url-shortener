import { randomInt } from "node:crypto";
import { z } from "zod";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const reservedCodes = new Set(["api", "health"]);

export const codeSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{3,32}$/, "Code must contain 3–32 letters, digits, underscores, or hyphens")
  .refine((code) => !reservedCodes.has(code.toLowerCase()), "This code is reserved");

export const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
    try {
      const url = new URL(value);
      return Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "URL must be an absolute HTTP(S) URL without credentials or unescaped whitespace")
  .transform((value) => new URL(value).href)
  .pipe(z.string().max(2048));

export const createUrlSchema = z.strictObject({
  url: urlSchema,
  customCode: codeSchema.optional(),
});

export const linkSchema = z.object({
  code: codeSchema,
  url: urlSchema,
  createdAt: z.iso.datetime(),
});

export type Link = z.infer<typeof linkSchema>;

export interface LinkStore {
  insert(code: string, url: string): Promise<Link | null>;
  find(code: string): Promise<Link | null>;
  healthy(): Promise<boolean>;
}

export interface LinkCache {
  readonly enabled: boolean;
  get(code: string): Promise<Link | null>;
  set(link: Link): Promise<void>;
  healthy(): Promise<boolean>;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function generateCode(): string {
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
}
