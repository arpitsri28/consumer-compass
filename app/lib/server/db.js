import "server-only";
import pg from "pg";
import { HttpError } from "./errors.js";

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new HttpError(503, "CONFIGURATION_ERROR", "Database is not configured.");
  }
  if (!globalThis.consumerCompassPool) {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 10000,
      application_name: "consumer-compass",
    });
    pool.on("error", () => console.error("An idle database connection failed."));
    globalThis.consumerCompassPool = pool;
  }
  return globalThis.consumerCompassPool;
}

export function databaseError(error) {
  return error instanceof HttpError ? error
    : new HttpError(503, "DATABASE_UNAVAILABLE", "Database is temporarily unavailable.");
}
