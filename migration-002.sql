CREATE TABLE IF NOT EXISTS users (
  device_id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  affiliation TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users (lower(name), tag);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  text TEXT,
  paper_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conv_id);

CREATE TABLE IF NOT EXISTS conv_reads (
  device_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, conv_id)
);

CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_sub TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_post ON replies (post_id);
