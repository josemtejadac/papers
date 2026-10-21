ALTER TABLE posts ADD COLUMN author_public_id TEXT;
ALTER TABLE posts ADD COLUMN edited_at TEXT;
CREATE TABLE IF NOT EXISTS paper_summaries (
  arxiv_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (arxiv_id, lang)
);
