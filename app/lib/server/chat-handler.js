import { getChatConfig } from "./chat-config.js";
import { readJsonBody, truncateHistory, validateMessages } from "./chat-validation.js";
import { errorResponse, HttpError } from "./errors.js";
import { upstreamError } from "./openrouter.js";
import { systemPrompt } from "./system-prompt.js";

function responseStream(completion, abortController, cleanup) {
  const iterator = completion[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let finished = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (!finished) {
          const { done, value } = await iterator.next();
          if (finished) return;
          if (abortController.signal.aborted) throw new Error("Request aborted");
          if (done) {
            finished = true;
            cleanup();
            controller.close();
            return;
          }
          if (value.error) throw new Error("Provider stream failed");
          const content = value.choices?.[0]?.delta?.content;
          if (content) {
            controller.enqueue(encoder.encode(content));
            return;
          }
        }
      } catch {
        if (finished) return;
        finished = true;
        abortController.abort();
        cleanup();
        // Headers are already sent: fail the transport, never append an error to legal advice.
        controller.error(new Error("The response was interrupted. Please try again."));
      }
    },
    async cancel() {
      finished = true;
      abortController.abort();
      cleanup();
      try { await iterator.return?.(); } catch { /* The upstream may already be aborted. */ }
    },
  });
}

export function createChatHandler({ verifyRequestUser, createCompletion, getConfig = getChatConfig }) {
  return async function POST(request) {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    const cleanup = () => request.signal.removeEventListener("abort", abort);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();

    try {
      await verifyRequestUser(request);
      const config = getConfig();
      const messages = validateMessages(await readJsonBody(request), config);
      if (abortController.signal.aborted) throw new HttpError(499, "REQUEST_ABORTED", "Request was cancelled.");

      let completion;
      try {
        completion = await createCompletion({
          model: config.OPENROUTER_MODEL,
          messages: [{ role: "system", content: systemPrompt }, ...truncateHistory(messages, config)],
          max_tokens: config.CHAT_MAX_OUTPUT_TOKENS,
          stream: true,
        }, { signal: abortController.signal });
      } catch (error) {
        throw upstreamError(error);
      }

      if (abortController.signal.aborted) throw new HttpError(499, "REQUEST_ABORTED", "Request was cancelled.");
      return new Response(responseStream(completion, abortController, cleanup), {
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
      return errorResponse(request.signal.aborted
        ? new HttpError(499, "REQUEST_ABORTED", "Request was cancelled.") : error);
    }
  };
}
