import { getPool } from "./db.js";
import { getRedis } from "./redis.js";

export function createHealthHandler({ database = () => getPool().query("SELECT 1"),
  redis = async () => (await getRedis()).ping() } = {}) {
  return async function GET() {
    const results = await Promise.allSettled([
      Promise.resolve().then(database), Promise.resolve().then(redis),
    ]);
    const checks = { database: results[0].status === "fulfilled",
      redis: results[1].status === "fulfilled" };
    const healthy = checks.database && checks.redis;
    return Response.json({ status: healthy ? "ok" : "unavailable", checks }, {
      status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" },
    });
  };
}
