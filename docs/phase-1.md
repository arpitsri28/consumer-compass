# Phase 1: authenticated and bounded chat API

This document describes the Phase 1 changes. `report.md` remains the historical review of the original prototype. Persistence, application rate limiting, broader chat/auth UX changes, CI, and deployment are deferred to the later requested phases.

One small build prerequisite was included: the profile page's redirect was moved from rendering into an effect after production prerendering exposed `ReferenceError: location is not defined`. A shared loading-aware guard remains in Phase 3.

## Local setup

1. Use Node.js 20.16 or newer and run `npm ci`.
2. Copy `.env.example` to `.env.local`.
3. In Firebase Console, select your project, enable Authentication > Sign-in method > Email/Password, and configure Authentication > Settings > Authorized domains for your deployment host.
4. Copy the web app configuration from Project settings > General into the `NEXT_PUBLIC_FIREBASE_*` fields.
5. In Project settings > Service accounts, generate a private key. Configure either `FIREBASE_SERVICE_ACCOUNT_JSON` (single-line JSON, takes precedence) or the three `FIREBASE_ADMIN_*` fields. Keep the downloaded key outside the repository. Both client and admin credentials must refer to the same Firebase project.
6. Set `OPENROUTER_API_KEY` and select `OPENROUTER_MODEL`. The default is the paid `meta-llama/llama-3.3-70b-instruct` model; account access and credits are required. No real provider call is made by the automated tests or build.
7. Run `npm run dev` and sign in through the existing UI.

`NEXT_PUBLIC_*` variables are public Firebase web configuration, embedded in the browser bundle at build time. Set them before `npm run build` and rebuild after changes. Admin credentials and the OpenRouter key are server-only runtime variables. Do not prefix server secrets with `NEXT_PUBLIC_`.

### Environment reference

| Variable | Purpose / default |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase web API key |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase authentication domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase project ID |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Web app storage bucket configuration; this app does not yet use storage |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Firebase web messaging sender ID |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase web app ID |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Optional service account JSON; takes precedence over individual fields |
| `FIREBASE_ADMIN_PROJECT_ID` | Required when JSON is not supplied |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | Required when JSON is not supplied |
| `FIREBASE_ADMIN_PRIVATE_KEY` | Required when JSON is not supplied; real newlines or literal `\n` supported |
| `OPENROUTER_API_KEY` | Required server-side provider credential |
| `OPENROUTER_MODEL` | Default: `meta-llama/llama-3.3-70b-instruct` |
| `CHAT_MAX_MESSAGES` | Maximum messages accepted per request: default 100, range 1–500 |
| `CHAT_MAX_MESSAGE_CHARS` | Maximum trimmed UTF-16 string length per message: default 8000, range 1–32000 |
| `CHAT_HISTORY_MAX_MESSAGES` | Maximum recent messages sent to the model: default 20, range 1–500 |
| `CHAT_HISTORY_MAX_CHARS` | History content character budget: default 24000, range 1–1000000; must be at least `CHAT_MAX_MESSAGE_CHARS` |
| `CHAT_MAX_OUTPUT_TOKENS` | Provider output token cap: default 1024, range 1–8192 |

Numeric settings must be positive integers. Invalid server configuration returns a safe 503 response. The body also has a fixed 1 MiB byte limit before JSON parsing, regardless of message-count settings.

## API contract

`POST /api/chat` requires `Content-Type: application/json` and `Authorization: Bearer <Firebase ID token>`.

```json
[
  { "role": "assistant", "content": "Welcome. How can I help?" },
  { "role": "user", "content": "Can I cancel my purchase?" }
]
```

Only `user` and `assistant` roles are allowed. Extra message fields, blank content, oversized content, too many messages, and a final message whose role is not `user` are rejected. The server owns the system prompt. Authentication happens before parsing the body or calling the provider.

The browser calls `currentUser.getIdToken()` for each request. Firebase reuses a valid cached token and refreshes it when necessary. The context retains the actual Firebase User instance so its methods remain available. The server calls Admin SDK `verifyIdToken(token, true)`, including revocation/disabled-user checks. Firebase verification failures caused by service infrastructure return 503 rather than treating them as invalid credentials.

Success returns raw UTF-8 text with `Content-Type: text/plain; charset=utf-8`, `Cache-Control: no-cache, no-store, no-transform`, and `X-Accel-Buffering: no`. Input to the model is a contiguous suffix of the validated history, bounded by message count and character budget. Whole messages are retained without splitting; the newest user message always fits due to configuration validation. The server prompt is additional to the history budget. Character counts are a simple approximation, not token counts. Output is separately bounded by `max_tokens`.

### Error contract

Before streaming begins, failures return JSON:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid chat messages.",
    "details": [{ "path": "0.role", "message": "Validation explanation" }]
  }
}
```

`details` is present only when useful for validation. It does not echo message content.

| Status | Meaning |
|---|---|
| 400 | Invalid JSON, content type, or message schema |
| 401 | Missing, malformed, expired, revoked, or otherwise invalid Firebase token |
| 413 | Body exceeds 1 MiB |
| 429 | Provider rate limit |
| 499 | Request aborted before a streaming response can be returned; nonstandard cancellation status |
| 502 | Other upstream failure, including rejected provider credentials or model requests |
| 503 | Missing/invalid server configuration, auth service outage, provider connection failure/timeout, or provider 503 |
| 500 | Unexpected internal failure; internal details are not returned |

Once streaming headers have been sent, HTTP status and content type cannot change. A mid-stream failure errors the response stream instead of appending JSON or error text to the assistant answer. The client checks HTTP errors before consuming text; full user-facing retry/error UX remains in Phase 3. The existing client still only logs failures to its console.

The request abort signal is bridged into the SDK request. Cancelling the response reader also aborts the upstream call and closes its iterator. The stream closes only on normal completion, never after an error. The SDK request timeout is 60 seconds and automatic retries are disabled so upstream rate limits and transient failures are returned promptly. This timeout is not a guaranteed total generation deadline after response headers arrive.

## Validation and dependencies

Run:

```bash
npm run lint
npm test
npm run build
```

The build requires the public Firebase web settings, but does not require working server credentials. To check compilation without real credentials, temporarily use `.env.example` as `.env.local`; these placeholders do not allow sign-in or real chat. Build-time font loading may require network access to Google Fonts.

Phase 1 tests use Node's built-in test runner with fake authentication/provider dependencies, without making network calls. `--experimental-default-type=module` lets tests import the existing JavaScript ES modules without changing the package module type. `--conditions=react-server` permits imports guarded by `server-only` in this server-side test process. Vitest and database integration tests remain in Phase 4.

New runtime dependencies:

- `firebase-admin`: official Firebase token verification, including signature, project, expiry, revocation, and disabled-user checks.
- `zod`: explicit request and configuration validation with readable errors.
- `server-only`: build-time protection against importing admin credentials/provider code into client components.

Tests cover validation, history/configuration bounds, credential parsing, mocked token verification, authentication before provider access, successful text streaming, upstream status mapping, transport errors, and cancellation. These are local checks, not evidence of a live Firebase/OpenRouter integration or deployment.

### Phase completion checks

- `npm run lint`: passed with no warnings or errors.
- `npm test`: 35 tests passed; no failures, cancellations, or skipped tests.
- `npm run build`: passed using placeholder public Firebase configuration. The first attempt was blocked by sandbox DNS access to Google Fonts; a network-enabled retry downloaded the font, and the final build passed after the profile redirect correction.
- No real Firebase or OpenRouter requests were used to verify authenticated chat. A manual sign-in/chat check with your own credentials remains required.

## Remaining limitations

This phase does not add persistence or application rate limiting. Valid users still supply their own history, within the new role and size restrictions. The original authentication loading race, registration failure bug, and overlapping client streams remain scheduled for Phase 3. Domain prompt content is unchanged; legal accuracy and citation grounding are not verified by this work. No AWS resources are provisioned.

Dependency installation reported 45 npm audit findings (20 moderate, 22 high, 3 critical). Those findings remain unresolved; this phase does not claim the dependency tree is production-ready. A separate dependency review and upgrade is needed before deployment.

## References

- [Firebase Admin ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Official OpenAI JavaScript SDK documentation](https://developers.openai.com/api/reference/typescript)
- [OpenRouter Llama 3.3 70B Instruct model](https://openrouter.ai/meta-llama/llama-3.3-70b-instruct)
