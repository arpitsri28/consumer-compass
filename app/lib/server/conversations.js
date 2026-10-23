import "server-only";
import { randomUUID } from "node:crypto";
import { getPool, databaseError } from "./db.js";
import { HttpError } from "./errors.js";

const notFound = () => new HttpError(404, "NOT_FOUND", "Conversation not found.");
const busy = () => new HttpError(409, "CONVERSATION_BUSY", "This conversation is generating a reply. Try again shortly.");
export const conversationTitle = (content) => Array.from(content.trim().replace(/\s+/g, " ")).slice(0, 100).join("");

export function createConversationStore(poolFactory = getPool) {
  async function query(sql, values) {
    try { return await poolFactory().query(sql, values); }
    catch (error) { throw databaseError(error); }
  }

  // A session lock serializes generation and deletion across app processes.
  // Hold a connection, but never an open transaction, while calling the model.
  async function lockConversation(uid, id) {
    let client;
    let locked = false;
    async function release() {
      if (!client) return;
      try {
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [id]);
        client.release();
      } catch {
        client.release(true);
      }
    }
    try {
      client = await poolFactory().connect();
      const owned = await client.query("SELECT id FROM conversations WHERE id = $1 AND user_id = $2", [id, uid]);
      if (!owned.rowCount) throw notFound();
      const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [id]);
      locked = result.rows[0].locked;
      if (!locked) throw busy();
      const stillOwned = await client.query("SELECT id FROM conversations WHERE id = $1 AND user_id = $2", [id, uid]);
      if (!stillOwned.rowCount) throw notFound();
      return { client, release };
    } catch (error) {
      await release();
      throw databaseError(error);
    }
  }

  async function rollback(client) {
    try { await client.query("ROLLBACK"); } catch { /* Release discards an unusable connection. */ }
  }

  return {
    async upsertUser({ uid, email }) {
      await query(`INSERT INTO users (id, email) VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`, [uid, email]);
    },
    async list(uid) {
      const result = await query(`SELECT id, title, created_at, updated_at FROM conversations
        WHERE user_id = $1 ORDER BY updated_at DESC, id`, [uid]);
      return result.rows;
    },
    async create(uid) {
      const result = await query(`INSERT INTO conversations (id, user_id) VALUES ($1, $2)
        RETURNING id, title, created_at, updated_at`, [randomUUID(), uid]);
      return result.rows[0];
    },
    async get(uid, id) {
      const result = await query(`SELECT id, title, created_at, updated_at FROM conversations
        WHERE id = $1 AND user_id = $2`, [id, uid]);
      if (!result.rowCount) throw notFound();
      const messages = await query(`SELECT m.id, m.role, m.content, m.incomplete, m.created_at
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.id = $1 AND c.user_id = $2 ORDER BY m.created_at, m.id`, [id, uid]);
      return { ...result.rows[0], messages: messages.rows };
    },
    async rename(uid, id, title) {
      const result = await query(`UPDATE conversations SET title = $3, updated_at = clock_timestamp()
        WHERE id = $1 AND user_id = $2 RETURNING id, title, created_at, updated_at`, [id, uid, title]);
      if (!result.rowCount) throw notFound();
      return result.rows[0];
    },
    async delete(uid, id) {
      const { client, release } = await lockConversation(uid, id);
      try {
        const result = await client.query("DELETE FROM conversations WHERE id = $1 AND user_id = $2", [id, uid]);
        if (!result.rowCount) throw notFound();
      } catch (error) { throw databaseError(error); }
      finally { await release(); }
    },
    async beginTurn(uid, id, content, historyLimit, retryMessageId) {
      const { client, release } = await lockConversation(uid, id);
      let assistantId;
      let messages;
      try {
        await client.query("BEGIN");
        if (retryMessageId) {
          const retry = await client.query(`UPDATE messages m SET content = '', incomplete = true
            WHERE m.id = $3 AND m.conversation_id = $1 AND m.role = 'assistant' AND m.incomplete
            AND EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2)
            AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.conversation_id = $1 AND newer.id > m.id)
            RETURNING m.id`, [id, uid, retryMessageId]);
          if (!retry.rowCount) {
            throw new HttpError(409, "RETRY_CONFLICT", "Only the latest incomplete reply can be retried. Reload the conversation.");
          }
          assistantId = retry.rows[0].id;
        } else {
          await client.query(`UPDATE conversations SET
            title = CASE WHEN title = 'New conversation' AND NOT EXISTS
              (SELECT 1 FROM messages WHERE conversation_id = $1) THEN $3 ELSE title END,
            updated_at = clock_timestamp() WHERE id = $1 AND user_id = $2`, [id, uid, conversationTitle(content)]);
          await client.query(`INSERT INTO messages (conversation_id, role, content)
            SELECT id, 'user', $3 FROM conversations WHERE id = $1 AND user_id = $2`, [id, uid, content]);
          const assistant = await client.query(`INSERT INTO messages (conversation_id, role, content, incomplete)
            SELECT id, 'assistant', '', true FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id`, [id, uid]);
          assistantId = assistant.rows[0].id;
        }
        const history = await client.query(`SELECT m.role, m.content FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.id = $1 AND c.user_id = $2 AND NOT m.incomplete
          ORDER BY m.created_at DESC, m.id DESC LIMIT $3`, [id, uid, historyLimit]);
        messages = history.rows.reverse();
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client);
        await release();
        throw databaseError(error);
      }

      let finalization;
      return {
        messages,
        finish(text, incomplete) {
          // Multiple abort/error signals may race; persist and release exactly once.
          if (!finalization) finalization = (async () => {
            try {
              await client.query("BEGIN");
              await client.query(`UPDATE messages SET content = $4, incomplete = $5
                WHERE id = $3 AND conversation_id = $1 AND EXISTS
                (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2)`, [id, uid, assistantId, text, incomplete]);
              await client.query(`UPDATE conversations SET updated_at = clock_timestamp()
                WHERE id = $1 AND user_id = $2`, [id, uid]);
              await client.query("COMMIT");
            } catch (error) {
              await rollback(client);
              throw databaseError(error);
            } finally { await release(); }
          })();
          return finalization;
        },
      };
    },
  };
}

export const conversations = createConversationStore();
