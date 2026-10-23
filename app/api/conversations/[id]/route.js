import { verifyRequestUser } from "../../../lib/server/firebase-admin.js";
import { conversations } from "../../../lib/server/conversations.js";
import { createConversationHandlers } from "../../../lib/server/conversation-handlers.js";
import { withRequestLogging } from "../../../lib/server/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createConversationHandlers({ verifyRequestUser, store: conversations });
export const GET = withRequestLogging(handlers.get, "/api/conversations/[id]");
export const PATCH = withRequestLogging(handlers.rename, "/api/conversations/[id]");
export const DELETE = withRequestLogging(handlers.delete, "/api/conversations/[id]");
