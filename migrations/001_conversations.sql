CREATE TABLE users (
  id text PRIMARY KEY,
  email text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation' CHECK (char_length(title) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  incomplete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (role = 'assistant' OR (NOT incomplete AND length(content) > 0))
);

CREATE INDEX conversations_user_updated_idx ON conversations (user_id, updated_at DESC, id);
CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at, id);
