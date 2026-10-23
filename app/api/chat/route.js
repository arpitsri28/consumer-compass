import { verifyRequestUser } from "../../lib/server/firebase-admin.js";
import { createCompletion } from "../../lib/server/openrouter.js";
import { conversations } from "../../lib/server/conversations.js";
import { createChatHandler } from "../../lib/server/chat-handler.js";
import { withRequestLogging } from "../../lib/server/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withRequestLogging(
  createChatHandler({ verifyRequestUser, createCompletion, store: conversations }), "/api/chat");
