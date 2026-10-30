import { readFile } from "node:fs/promises";
import pg from "pg";
import type { Link, LinkStore } from "./domain.js";

type LinkRow = { code: string; original_url: string; created_at: Date };

function toLink(row: LinkRow): Link {
  return { code: row.code, url: row.original_url, createdAt: row.created_at.toISOString() };
}

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    statement_timeout: 3000,
  });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize schema initialization when multiple API instances start together.
    await client.query("SELECT pg_advisory_xact_lock(741923581)");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresLinkStore implements LinkStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(code: string, url: string): Promise<Link | null> {
    const result = await this.pool.query<LinkRow>(
      `INSERT INTO short_urls (code, original_url) VALUES ($1, $2)
       ON CONFLICT (code) DO NOTHING RETURNING code, original_url, created_at`,
      [code, url],
    );
    return result.rows[0] ? toLink(result.rows[0]) : null;
  }

  async find(code: string): Promise<Link | null> {
    const result = await this.pool.query<LinkRow>(
      "SELECT code, original_url, created_at FROM short_urls WHERE code = $1",
      [code],
    );
    return result.rows[0] ? toLink(result.rows[0]) : null;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
