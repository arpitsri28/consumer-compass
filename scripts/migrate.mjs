import { readdir, readFile } from 'node:fs/promises';
import { getPool } from '../app/lib/server/db.js';

const pool = getPool();
let client;
try {
  client = await pool.connect();
  await client.query('SELECT pg_advisory_lock(793021)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations
    (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((name) => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  for (const name of files) {
    const existing = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [name]);
    if (existing.rowCount) continue;
    try {
      await client.query('BEGIN');
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} catch {
  console.error('Migration failed. Check database connectivity and migration SQL.');
  process.exitCode = 1;
} finally {
  if (client) client.release(true);
  await pool.end();
}
