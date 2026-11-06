import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!connectionString) {
  throw new Error("DATABASE_URL_UNPOOLED is required to run migrations.");
}

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const pool = new Pool({ connectionString });

try {
  await pool.query(`
    create table if not exists public.held_schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  for (const name of migrationFiles) {
    const migration = await readFile(join(migrationsDirectory, name), "utf8");
    const checksum = createHash("sha256").update(migration).digest("hex");
    const existing = await pool.query(
      "select checksum from public.held_schema_migrations where name = $1",
      [name],
    );
    if (existing.rows.length) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration ${name} was modified; add a new migration instead.`);
      }
      console.log(`Already applied ${name}`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(migration);
      await client.query(
        "insert into public.held_schema_migrations (name, checksum) values ($1, $2)",
        [name, checksum],
      );
      await client.query("commit");
      console.log(`Applied ${name}`);
    } catch (error) {
      try {
        await client.query("rollback");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Migration ${name} failed and its transaction could not be rolled back.`,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
