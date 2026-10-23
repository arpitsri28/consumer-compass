export class ApiError extends Error {
  constructor(message, status, code, retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function retryAfterSeconds(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : 0;
}

export async function chatRequest(user, path, options = {}) {
  if (!user) throw new Error("Please sign in to continue.");
  const token = await user.getIdToken();
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.error?.details?.[0]?.message;
    const message = body?.error?.message || "The request failed. Please try again.";
    throw new ApiError(detail ? `${message} ${detail}` : message,
      response.status, body?.error?.code, retryAfterSeconds(response.headers.get("Retry-After")));
  }
  return response;
}

export function resolveChatRetry(attempt, messages) {
  const last = messages.at(-1);
  if (attempt.body.retryMessageId) {
    if (last?.id !== attempt.body.retryMessageId) return { kind: "review" };
    return last.incomplete ? { kind: "generate", body: attempt.body } : { kind: "complete" };
  }
  const fresh = messages.filter((entry) => !attempt.beforeIds.includes(entry.id));
  if (!fresh.length) {
    // These HTTP errors occur before any turn is stored. An ambiguous network failure needs review.
    return [400, 401, 413, 429].includes(attempt.status)
      ? { kind: "generate", body: attempt.body } : { kind: "review" };
  }
  if (fresh.length === 2 && fresh[0].role === "user" && fresh[0].content === attempt.body.message && last?.role === "assistant") {
    return last.incomplete
      ? { kind: "generate", body: { conversationId: attempt.body.conversationId, retryMessageId: last.id } }
      : { kind: "complete" };
  }
  return { kind: "review" };
}
