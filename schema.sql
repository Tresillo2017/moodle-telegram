CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER PRIMARY KEY,
  moodle_url TEXT NOT NULL,
  token TEXT NOT NULL,
  moodle_user_id INTEGER,
  full_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seen_items (
  chat_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, item_type, item_id)
);
