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

ALTER TABLE users ADD COLUMN alexia_username TEXT;
ALTER TABLE users ADD COLUMN alexia_password TEXT;

CREATE TABLE IF NOT EXISTS absence_alerts (
  chat_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  threshold TEXT NOT NULL,
  PRIMARY KEY (chat_id, subject, threshold)
);

-- Last-seen absence hours per subject, used to detect a newly-registered
-- absence (hours increased since the last poll) independently of the
-- 80%/100% threshold alerts in absence_alerts.
CREATE TABLE IF NOT EXISTS absence_last_seen (
  chat_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  hours REAL NOT NULL,
  PRIMARY KEY (chat_id, subject)
);
