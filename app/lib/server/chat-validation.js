import { z } from "zod";
import { HttpError } from "./errors.js";

const MAX_BODY_BYTES = 1024 * 1024;

function parse(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_REQUEST", "Invalid request.",
      parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })));
  }
  return parsed.data;
}

export function validateChatRequest(body, config) {
  const conversationId = z.string().uuid();
  return parse(z.object({
    conversationId,
    message: z.string().trim().min(1).max(config.CHAT_MAX_MESSAGE_CHARS).optional(),
    retryMessageId: z.string().refine((value) => /^[1-9]\d{0,18}$/.test(value) &&
      BigInt(value) <= 9223372036854775807n, { message: "Invalid assistant message ID." }).optional(),
  }).strict().refine((value) => (value.message === undefined) !== (value.retryMessageId === undefined),
    { message: "Provide exactly one of message or retryMessageId." }), body);
}

export function validateConversationId(id) {
  return parse(z.string().uuid(), id);
}

export function validateTitle(body) {
  return parse(z.object({ title: z.string().trim().min(1).max(100) }).strict(), body).title;
}

export async function readJsonBody(request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(400, "INVALID_REQUEST", "Content-Type must be application/json.");
  }
  if (!request.body) {
    throw new HttpError(400, "INVALID_REQUEST", "A JSON body is required.");
  }

  // Bound bytes before parsing; schema validation alone still buffers arbitrary input.
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "BODY_TOO_LARGE", "Request body must not exceed 1 MiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

export function truncateHistory(messages, config) {
  const selected = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (selected.length >= config.CHAT_HISTORY_MAX_MESSAGES ||
        characters + message.content.length > config.CHAT_HISTORY_MAX_CHARS) break;
    selected.push(message);
    characters += message.content.length;
  }
  return selected.reverse();
}
