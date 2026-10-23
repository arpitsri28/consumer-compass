import { errorResponse } from "./errors.js";
import { readJsonBody, validateConversationId, validateTitle } from "./chat-validation.js";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function createConversationHandlers({ verifyRequestUser, store }) {
  function authenticated(action) {
    return async (request, context) => {
      try {
        const user = await verifyRequestUser(request);
        await store.upsertUser(user);
        return await action(request, context, user.uid);
      } catch (error) { return errorResponse(error); }
    };
  }
  async function idFrom(context) {
    return validateConversationId((await context.params).id);
  }
  return {
    list: authenticated(async (_request, _context, uid) => json({ conversations: await store.list(uid) })),
    create: authenticated(async (_request, _context, uid) => json({ conversation: await store.create(uid) }, 201)),
    get: authenticated(async (_request, context, uid) => json({ conversation: await store.get(uid, await idFrom(context)) })),
    rename: authenticated(async (request, context, uid) => {
      const id = await idFrom(context);
      const title = validateTitle(await readJsonBody(request));
      return json({ conversation: await store.rename(uid, id, title) });
    }),
    delete: authenticated(async (_request, context, uid) => {
      await store.delete(uid, await idFrom(context));
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }),
  };
}
