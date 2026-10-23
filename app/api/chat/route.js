import { verifyRequestUser } from "../../lib/server/firebase-admin.js";
import { createCompletion } from "../../lib/server/openrouter.js";
import { createChatHandler } from "../../lib/server/chat-handler.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createChatHandler({ verifyRequestUser, createCompletion });
