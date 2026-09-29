import { describe, it, expect, vi, afterEach } from "vitest";
import pg from "pg";
import type { Pool as PgPool } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresBackend } from "./backend.js";
import { searchKeyword } from "./search.js";
import { loadConfig } from "../../daemon/config.js";

/**
 * fts_vector must be built with the config searchKeyword queries with.
 *
 * init.sql's trigger used to_tsvector('english', …) while every query used
 * to_tsquery('simple', …). Stemmed words never matched: "sourceone" was stored
 * as 'sourceon', "Berichte" survived only by luck of the English stemmer. On
 * 2026-09-29 a fresh 164k-chunk index returned nothing for "sourceone" although
 * 8,700 chunks contained it.
 *
 * Runs against a scratch database on the configured Postgres server, created
 * and dropped here — never touches the real database.
 */

const { Pool } = pg;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const initSql = readFileSync(join(repoRoot, "docker", "init.sql"), "utf-8");
/** The schema as databases created before the fix have it. */
const legacyInitSql = initSql.replace(
  "to_tsvector('simple', COALESCE(NEW.text, ''))",
  "to_tsvector('english', COALESCE(NEW.text, ''))"
);

const runMigrations = (
  PostgresBackend as unknown as { runMigrations(pool: PgPool): Promise<void> }
).runMigrations;

function scratchTargets(): { scratchUrl: string; adminUrl: string; dbName: string } {
  const base = loadConfig().postgres?.connectionString;
  if (!base) {
    throw new Error("postgres.connectionString not configured — cannot run scratch-db test");
  }
  const dbName = `pai_test_fts_${Math.random().toString(36).slice(2, 10)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return { scratchUrl: scratch.toString(), adminUrl: admin.toString(), dbName };
}

async function withScratchDb(schema: string, fn: (pool: PgPool) => Promise<void>): Promise<void> {
  const { scratchUrl, adminUrl, dbName } = scratchTargets();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  try {
    const pool = new Pool({ connectionString: scratchUrl, max: 2 });
    try {
      await pool.query(schema);
      await fn(pool);
    } finally {
      await pool.end();
    }
  } finally {
    const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await cleanup.end();
    }
  }
}

async function insertChunk(pool: PgPool, id: string, text: string): Promise<void> {
  await pool.query(
    `INSERT INTO pai_chunks (id, project_id, path, start_line, end_line, hash, text, updated_at)
     VALUES ($1, 1, 'notes.md', 1, 1, $1, $2, 0)`,
    [id, text]
  );
}

const hits = async (pool: PgPool, q: string): Promise<string[]> =>
  (await searchKeyword(pool, q)).map((r) => r.snippet);

afterEach(() => vi.restoreAllMocks());

describe("keyword search config", () => {
  it("a fresh schema indexes words exactly as queries look them up", async () => {
    await withScratchDb(initSql, async (pool) => {
      await runMigrations(pool);
      await insertChunk(pool, "a", "Deploy sourceone to staging");
      await insertChunk(pool, "b", "Die Monatsberichte sind überfällig");

      expect(await hits(pool, "sourceone")).toHaveLength(1);
      expect(await hits(pool, "monatsberichte")).toHaveLength(1);
      expect(await hits(pool, "überfällig")).toHaveLength(1);
    });
  }, 30000);

  it("migrates a legacy 'english' database: rebuilds vectors, then is a no-op", async () => {
    await withScratchDb(legacyInitSql, async (pool) => {
      await insertChunk(pool, "a", "Deploy sourceone to staging");
      await insertChunk(pool, "b", "Die Monatsberichte sind überfällig");
      // The bug, reproduced: the stemmed vector misses the literal query.
      expect(await hits(pool, "sourceone")).toHaveLength(0);

      const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await runMigrations(pool);
      const rebuilt = log.mock.calls.filter((c) => String(c[0]).includes("fts_vector rebuilt"));
      expect(rebuilt).toHaveLength(1);
      expect(String(rebuilt[0]![0])).toContain("(2 chunks)");

      expect(await hits(pool, "sourceone")).toHaveLength(1);
      expect(await hits(pool, "monatsberichte")).toHaveLength(1);

      // The trigger itself is fixed, not just the existing rows.
      await insertChunk(pool, "c", "sourceone reports");
      expect(await hits(pool, "sourceone")).toHaveLength(2);

      log.mockClear();
      await runMigrations(pool);
      expect(log.mock.calls.some((c) => String(c[0]).includes("fts_vector rebuilt"))).toBe(false);
    });
  }, 30000);
});
