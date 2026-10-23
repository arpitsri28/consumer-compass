# Phase 3: rate limits, chat controls, and authentication UI

This phase adds Redis quotas, safer chat retry behavior, Stop, keyboard submission, scrolling, Markdown rendering, and the remaining authentication UI fixes. The earlier phase reports describe historical snapshots; this document describes the current behavior.

## Setup and configuration

Keep the Firebase, OpenRouter, and PostgreSQL settings from [Phase 1](phase-1.md) and [Phase 2](phase-2.md). Install dependencies with `npm ci` and add these server-only settings to `.env.local`:

| Variable | Default / behavior |
|---|---|
| `REDIS_URL` | No implicit default in code; `.env.example` uses `redis://localhost:6379`. Missing or unavailable Redis causes fail-open behavior with a warning. |
| `CHAT_RATE_LIMIT_MAX_REQUESTS` | 10 requests per user per window; positive integer, maximum 10000 |
| `CHAT_RATE_LIMIT_WINDOW_SECONDS` | 60 seconds; positive integer, maximum 86400 |
| `TEST_REDIS_URL` | Optional, explicit disposable Redis URL for `npm run test:redis` |

For disposable local Redis:

```bash
docker run --rm --name consumer-compass-dev-redis \
  -p 127.0.0.1:6379:6379 -d redis:7-alpine
```

Use a private Redis connection for deployment. The sample container exposes Redis only on localhost and loses its counters when removed. Development/production Compose configuration remains in later phases.

No new SQL migration is required in this phase. The existing message ID and incomplete flag support retrying a failed reply.

## Rate limiting

`POST /api/chat` authenticates the Firebase token, validates server configuration, and checks the verified uid's Redis counter before database writes or model calls. All authenticated attempts count, including retries, invalid request bodies, and requests for unowned conversations. Unauthenticated requests are rejected before Redis access. Other API routes are not rate-limited in this phase.

A short Lua script atomically increments the user's counter, attaches an expiry when the window starts, and returns the counter and remaining TTL. A counter without an expiry is repaired. Rejected calls do not extend the window. Keys contain a SHA-256 hash of the uid, with an application/version prefix; no token, message content, or email is stored in Redis.

This is a fixed window anchored to the user's first request after the previous key expires. It is shared across app processes using the same Redis service. The threshold request is allowed; the next request receives:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many chat requests. Please wait before trying again."
  }
}
```

`Retry-After` is the rounded-up remaining TTL in seconds, at least one second. The browser disables Retry until that interval has elapsed. Provider rate limits remain a separate `UPSTREAM_RATE_LIMITED` error from Phase 1; the app does not invent a provider retry deadline when one is unavailable.

### Redis outage behavior

Redis errors deliberately fail open: the request proceeds to PostgreSQL and the model without a quota decision. Availability takes priority over a strict quota during this failure. This also means Redis downtime temporarily removes this application-level spending/abuse control; it is not a hard billing cap.

The Redis client has 500 ms connection and command timeouts, no offline command queue, and no command retries. A failed connection is retried by a later request rather than held in a background retry loop. A generic warning is emitted at most once per minute per process; it includes no connection URL, credentials, uid, token, or message content. Invalid numeric quota configuration returns 503 rather than silently disabling the limiter. Structured logging and health checks remain in Phase 5.

Fixed windows can permit a burst across a window boundary. This is a deliberate simplicity tradeoff; sliding windows or token buckets can be considered if that behavior becomes a problem.

## Chat behavior

- Send and the input are disabled during generation, and a synchronous operation guard prevents overlapping sends before React rerenders.
- Blank input is blocked.
- Enter sends; Shift+Enter adds a newline. Enter while composing an IME character does not submit.
- Stop aborts the model fetch through an `AbortController`. The server retains the Phase 2 partial-response persistence behavior.
- Navigation or switching users aborts the workspace's in-flight requests. The workspace remains keyed by Firebase uid.
- The message list scrolls to the latest content as messages change.
- HTTP failures are checked before reading text and displayed in a MUI Snackbar/Alert. Failed operations have a Retry action; rate-limit errors show the retry countdown.
- User messages remain plain text. Assistant messages render as Markdown.

Stop uses a separate generation controller from the surrounding operation, allowing fresh transcript/list reads after the model fetch is aborted. The server may still be finalizing the partial reply when that first read completes; reopening the conversation refreshes the saved state. An ambiguous network failure does not cause an automatic repeated send.

### Retry without duplicate questions

The existing new-question body remains:

```json
{
  "conversationId": "123e4567-e89b-42d3-a456-426614174000",
  "message": "Can I cancel my purchase?"
}
```

A failed reply that was already stored can instead be retried using its assistant message ID:

```json
{
  "conversationId": "123e4567-e89b-42d3-a456-426614174000",
  "retryMessageId": "42"
}
```

The two request shapes are strict and mutually exclusive. Retry IDs must be positive bigint-compatible decimal strings. Client history and arbitrary roles remain disallowed.

Before retrying, the browser reloads the authoritative transcript and compares its rows with those present before the failed attempt:

1. If the question and an incomplete assistant reply were saved, regenerate that assistant row in place.
2. If the reply already completed, show the saved reply without generating it again.
3. If an HTTP response proves the request was rejected before a turn was stored (400, 401, 413, or application 429), the original question can be submitted again after transcript reconciliation.
4. If another turn appeared, or a network failure left no clear evidence of whether the question was saved, reload the conversation and restore the draft for user review instead of blindly resending.

The server checks ownership and takes the same conversation lock used by normal generation. Only the conversation's latest incomplete assistant row can be retried. A completed, stale, or unrelated target returns 409; another user's conversation returns 404. The retry reuses the existing user message, clears/replaces the assistant text, and loads history from PostgreSQL. It does not append duplicate rows. Retrying deliberately replaces the previous partial assistant text; attempts are not versioned.

This is conservative retry recovery, not a general idempotency-key protocol. A manually repeated new question is still a new turn. Retry controls cannot repair an invalid input without editing; dismiss the error, edit the draft, and submit again when needed.

### Markdown safety

`react-markdown` is used without raw-HTML plugins or `dangerouslySetInnerHTML`. Raw HTML is skipped, the library's default safe URL transformation remains enabled, and remote Markdown images are disabled to prevent unsolicited image requests. Code is displayed as text without execution or syntax-highlighter dependencies. Links open with `rel="noopener noreferrer"`.

Automated render tests exercise formatting, raw HTML/script injection, unsafe `javascript:`/`data:` links, and remote images using the actual shared Markdown configuration.

## Authentication changes

`AuthGuard` waits for Firebase's `loading` flag before deciding whether to redirect. It protects chat and profile, and its guest mode redirects authenticated users away from login/register. Redirects run in effects, never during rendering.

`AuthProvider` is mounted once through a dedicated client `Providers` component. The root layout is now a server component and exports Consumer Compass title/description metadata. The duplicate homepage provider was removed.

Login and registration share `AuthPage` and `AuthForm`. Native forms submit on Enter, validate required email/password inputs, disable controls while pending, show one error, and reset pending state after failure. A ref prevents duplicate authentication submissions before React rerenders. The broken registration state setter and duplicate login error output have been removed. Form sizing now uses responsive widths and replaces the `100wh` typo.

Unused Google sign-in, password-reset, and password-update helpers were removed rather than exposing unfinished flows. Email/password registration, sign-in, and sign-out remain. Logout waits for the sign-out promise before navigating, shares the pending promise across effect replays, and shows a retryable error if sign-out fails.

## Dependencies

Only two runtime dependencies were added:

- `ioredis` 6.0.0: the requested Redis client; connection handling and Lua script execution.
- `react-markdown` 10.1.0: the requested Markdown renderer; safe React output without raw HTML support.

Tests still use Node's built-in runner. Server tests run with the `react-server` condition for `server-only` imports; client/helper/Markdown render tests run separately with normal React. Vitest migration and CI remain in Phase 4.

## Verification

```bash
npm run lint
npm test
npm run test:db
npm run test:redis
npm run build
```

For PostgreSQL tests, follow the dedicated `_test` database setup in [Phase 2](phase-2.md). `npm run test:db` now includes retry-in-place, completed/stale target rejection, ownership checks, and all earlier persistence tests.

For Redis integration tests, start a disposable instance and set `TEST_REDIS_URL=redis://localhost:56379/15` in `.env.local`:

```bash
docker run --rm --name consumer-compass-test-redis \
  -p 127.0.0.1:56379:6379 -d redis:7-alpine
npm run test:redis
docker stop consumer-compass-test-redis
```

The Redis tests require an explicit test URL, create unique fixture uids, and delete only their own counter keys. They never flush a database. Real Redis tests cover concurrent quota decisions, user isolation, expiry/reset, and TTL repair. Failure-open behavior is tested with mocked connection/command failures. Live Firebase verification and OpenRouter generation remain mocked.

### Phase completion checks

- `npm run lint`: passed without warnings or errors.
- `npm test`: 51 server tests and 10 client/Markdown tests passed, with no failures or skipped tests.
- `npm run test:db`: 12 PostgreSQL integration scenarios passed (13 tests including the parent).
- `npm run test:redis`: four Redis integration scenarios passed (five tests including the parent).
- `npm run build`: passed with placeholder Firebase web configuration. The initial sandboxed attempt could not resolve Google Fonts; the network-enabled build succeeded. The build reported an outdated Browserslist data warning.
- Real sign-in, registration, logout, keyboard/scroll behavior, and Stop interactions still require a browser review with your credentials. No live Firebase/OpenRouter integration or AWS deployment is claimed.

Temporary test containers and the placeholder `.env.local` are removed after verification. npm installation continues to report the same 45 dependency audit findings; dependency security upgrades remain unresolved before deployment.

## Suggested manual review

1. Configure `.env.local`, migrate your database, start PostgreSQL/Redis, and run the app.
2. Reload `/chat` and `/profile` while already signed in; verify that no premature login redirect occurs.
3. Test failed registration and login, retry them, and verify a single error with controls re-enabled. Submit the forms with Enter.
4. Sign out and verify navigation happens after Firebase completes; verify protected pages require sign-in.
5. Send a multiline question, stop a streaming response, and reopen the conversation to verify the saved partial reply.
6. Simulate an upstream failure, use Retry, and verify the question appears only once and the assistant row is replaced.
7. Set a small quota, exceed it, and verify 429 plus the Retry countdown. Stop Redis and verify requests proceed with a warning.
8. Verify Markdown lists/code/links and that raw HTML and Markdown images do not create active content.

## References

- [Redis INCR rate-limiter patterns and Lua atomicity](https://redis.io/docs/latest/commands/incr/)
- [ioredis connection and command options](https://redis.github.io/ioredis/interfaces/CommonRedisOptions.html)
- [react-markdown security and rendering options](https://github.com/remarkjs/react-markdown)
