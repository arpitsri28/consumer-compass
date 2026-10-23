import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { errorResponse } from "./errors.js";

const requests = new AsyncLocalStorage();

export function createLogger(destination) {
  const level = ["trace", "debug", "info", "warn", "error", "fatal", "silent"].includes(process.env.LOG_LEVEL)
    ? process.env.LOG_LEVEL : "info";
  return pino({ level, base: { service: "consumer-compass" },
    redact: { paths: ["authorization", "password", "token", "content", "messages", "headers", "body", "err"], remove: true },
  }, destination);
}

const logger = createLogger();

export function setRequestUser(uid) {
  const context = requests.getStore();
  if (context) context.uid = uid;
}

// Events are static names; never pass provider errors, request bodies, or headers.
export function logEvent(level, event) {
  logger[level]({ event, ...requests.getStore() });
}

export function withRequestLogging(handler, path, sink = logger) {
  return async function logged(request, ...args) {
    const context = { requestId: randomUUID(), method: request.method, path, uid: null };
    const started = performance.now();
    return requests.run(context, async () => {
      let status = 499;
      let finished = false;
      const finish = (outcome) => {
        if (finished) return;
        finished = true;
        request.signal.removeEventListener("abort", aborted);
        sink.info({ event: "request_completed", ...context, status, outcome,
          latencyMs: Math.round((performance.now() - started) * 100) / 100 });
      };
      const aborted = () => finish("aborted");
      request.signal.addEventListener("abort", aborted, { once: true });
      let response;
      try { response = await handler(request, ...args); }
      catch (error) { response = errorResponse(error); }
      status = response.status;
      const headers = new Headers(response.headers);
      headers.set("X-Request-ID", context.requestId);

      if (!response.body || !response.headers.get("content-type")?.startsWith("text/plain")) {
        finish(request.signal.aborted ? "aborted" : "complete");
        return new Response(response.body, { status, headers });
      }
      // Observe stream completion without buffering it or losing cancellation propagation.
      const reader = response.body.getReader();
      let cancelled = false;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (cancelled) return;
            if (result.done) { finish("complete"); controller.close(); }
            else controller.enqueue(result.value);
          } catch (error) { finish("error"); if (!cancelled) controller.error(error); }
        },
        async cancel(reason) {
          cancelled = true;
          finish("cancelled");
          await reader.cancel(reason);
        },
      });
      if (request.signal.aborted) finish("aborted");
      return new Response(body, { status, headers });
    });
  };
}
