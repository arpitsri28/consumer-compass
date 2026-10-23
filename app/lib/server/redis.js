import "server-only";
import Redis from "ioredis";

export async function getRedis() {
  if (!process.env.REDIS_URL) throw new Error("Redis is not configured.");
  let connection = globalThis.consumerCompassRedis;
  if (!connection || connection.client.status === "end") {
    const client = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 500,
      commandTimeout: 500,
      retryStrategy: () => null,
    });
    client.on("error", () => {}); // The limiter logs a redacted warning when a request fails open.
    connection = { client, ready: client.connect() };
    connection.ready.catch(() => client.disconnect());
    globalThis.consumerCompassRedis = connection;
  }
  await connection.ready;
  return connection.client;
}
