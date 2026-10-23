import { getChatConfig } from "./chat-config.js";
import { readJsonBody, truncateHistory, validateChatRequest } from "./chat-validation.js";
import { errorResponse, HttpError } from "./errors.js";
import { upstreamError } from "./openrouter.js";
import { systemPrompt } from "./system-prompt.js";
import { checkRateLimit as defaultRateLimit } from "./rate-limit.js";

function responseStream(completion, abortController, turn, cleanup) {
  const encoder = new TextEncoder();
  let text = "";
  let settled = false;
  let cancelled = false;
  let finalization;
  let streamController;
  const interrupted = () => new Error("The response was interrupted. Please try again.");

  function finish(incomplete, error) {
    if (finalization) return finalization;
    settled = true;
    abortController.signal.removeEventListener("abort", onAbort);
    if (incomplete) abortController.abort();
    finalization = (async () => {
      try {
        await turn.finish(text, incomplete);
        if (!cancelled) {
          if (error) streamController.error(interrupted());
          else streamController.close();
        }
      } catch {
        console.error("Assistant reply could not be persisted.");
        if (!cancelled) streamController.error(interrupted());
      } finally { cleanup(); }
    })();
    return finalization;
  }
  function onAbort() { void finish(true, interrupted()); }

  return new ReadableStream({
    start(controller) {
      streamController = controller;
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      if (abortController.signal.aborted) { onAbort(); return; }
      // Drain independently of downstream reads so disconnects still finalize persistence.
      void (async () => {
        try {
          for await (const chunk of completion) {
            if (settled) break;
            if (chunk.error) throw interrupted();
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              text += content;
              controller.enqueue(encoder.encode(content));
            }
          }
          if (!settled) await finish(false);
        } catch {
          if (!settled) await finish(true, interrupted());
        }
      })();
    },
    async cancel() {
      cancelled = true;
      await finish(true, interrupted());
    },
  });
}

export function createChatHandler({ verifyRequestUser, createCompletion, store, getConfig = getChatConfig, checkRateLimit = defaultRateLimit }) {
  return async function POST(request) {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    // Bound the time a generation can occupy a database connection, including a stalled stream.
    const deadline = setTimeout(abort, 120000);
    deadline.unref?.();
    const cleanup = () => {
      request.signal.removeEventListener("abort", abort);
      clearTimeout(deadline);
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    let turn;

    try {
      const user = await verifyRequestUser(request);
      const config = getConfig();
      const limit = await checkRateLimit(user.uid, config);
      if (!limit.allowed) {
        throw new HttpError(429, "RATE_LIMITED", "Too many chat requests. Please wait before trying again.",
          undefined, { "Retry-After": String(limit.retryAfter) });
      }
      await store.upsertUser(user);
      const { conversationId, message, retryMessageId } = validateChatRequest(await readJsonBody(request), config);
      if (abortController.signal.aborted) throw new HttpError(499, "REQUEST_ABORTED", "Request was cancelled.");
      turn = await store.beginTurn(user.uid, conversationId, message, config.CHAT_HISTORY_MAX_MESSAGES, retryMessageId);
      if (abortController.signal.aborted) throw new HttpError(499, "REQUEST_ABORTED", "Request was cancelled.");

      let completion;
      try {
        completion = await createCompletion({
          model: config.OPENROUTER_MODEL,
          messages: [{ role: "system", content: systemPrompt }, ...truncateHistory(turn.messages, config)],
          max_tokens: config.CHAT_MAX_OUTPUT_TOKENS,
          stream: true,
        }, { signal: abortController.signal });
      } catch (error) { throw upstreamError(error); }

      return new Response(responseStream(completion, abortController, turn, cleanup), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-store, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      cleanup();
      abortController.abort();
      if (turn) {
        try { await turn.finish("", true); }
        catch { console.error("Failed request could not be finalized in the database."); }
      }
      return errorResponse(request.signal.aborted
        ? new HttpError(499, "REQUEST_ABORTED", "Request was cancelled.") : error);
    }
  };
}
