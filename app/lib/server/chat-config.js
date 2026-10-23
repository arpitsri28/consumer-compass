import { z } from "zod";
import { HttpError } from "./errors.js";

const positiveInteger = (fallback, max) =>
  z.coerce.number().int().positive().max(max).default(fallback);

const configSchema = z.object({
  OPENROUTER_MODEL: z.string().trim().min(1).default("meta-llama/llama-3.3-70b-instruct"),
  CHAT_MAX_MESSAGE_CHARS: positiveInteger(8000, 32000),
  CHAT_HISTORY_MAX_MESSAGES: positiveInteger(20, 500),
  CHAT_HISTORY_MAX_CHARS: positiveInteger(24000, 1000000),
  CHAT_MAX_OUTPUT_TOKENS: positiveInteger(1024, 8192),
  CHAT_RATE_LIMIT_MAX_REQUESTS: positiveInteger(10, 10000),
  CHAT_RATE_LIMIT_WINDOW_SECONDS: positiveInteger(60, 86400),
}).refine(
  (config) => config.CHAT_HISTORY_MAX_CHARS >= config.CHAT_MAX_MESSAGE_CHARS,
  { message: "CHAT_HISTORY_MAX_CHARS must be at least CHAT_MAX_MESSAGE_CHARS" },
);

export function getChatConfig(env = process.env) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new HttpError(503, "CONFIGURATION_ERROR", "Chat service is not configured correctly.");
  }
  return parsed.data;
}
