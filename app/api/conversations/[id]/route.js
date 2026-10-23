import { verifyRequestUser } from "../../../lib/server/firebase-admin.js";
import { conversations } from "../../../lib/server/conversations.js";
import { createConversationHandlers } from "../../../lib/server/conversation-handlers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createConversationHandlers({ verifyRequestUser, store: conversations });
export const GET = handlers.get;
export const PATCH = handlers.rename;
export const DELETE = handlers.delete;
