import "./config.js";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sampleApplication } from "./config.js";

for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
  if (!process.env[key]) throw new Error(`Missing ${key}. Configure the repository .env or environment variables.`);
}

export const pool = new Pool({ connectionTimeoutMillis: 5000 });
pool.on("error", (error) => console.error(`PostgreSQL connection error: ${error.message}`));

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize setup if two control planes start at the same time.
    await client.query("SELECT pg_advisory_xact_lock(738102)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const version = "001_applications";
    const applied = await client.query("SELECT version FROM schema_migrations WHERE version = $1", [version]);
    if (applied.rowCount === 0) {
      await client.query(await readFile(resolve(__dirname, "..", "..", "migrations", `${version}.sql`), "utf8"));
      const app = sampleApplication;
      // Seed once, in the migration transaction. Deleting it does not resurrect it.
      await client.query(`INSERT INTO applications
        (id, name, docker_image, container_name, container_port, host_port, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [app.id, app.name, app.image, app.containerName, app.containerPort, app.hostPort, app.status]);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
