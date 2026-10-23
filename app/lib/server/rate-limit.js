import "server-only";
import { createHash } from "node:crypto";
import { getRedis } from "./redis.js";

export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

let lastWarning = 0;
function warnUnavailable() {
  const now = Date.now();
  if (now - lastWarning >= 60000) {
    console.warn("Redis rate limiting is unavailable; allowing chat requests without a quota check.");
    lastWarning = now;
  }
}

export function createRateLimiter({ getClient = getRedis, warn = warnUnavailable } = {}) {
  return async function checkRateLimit(uid, config) {
    try {
      const client = await getClient();
      const key = `consumer-compass:chat-rate:v1:${createHash("sha256").update(uid).digest("hex")}`;
      const [count, ttl] = await client.eval(RATE_LIMIT_SCRIPT, 1, key,
        config.CHAT_RATE_LIMIT_WINDOW_SECONDS * 1000);
      return {
        allowed: count <= config.CHAT_RATE_LIMIT_MAX_REQUESTS,
        retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
      };
    } catch {
      warn();
      return { allowed: true, retryAfter: 0, degraded: true };
    }
  };
}

export const checkRateLimit = createRateLimiter();
