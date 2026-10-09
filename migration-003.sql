CREATE TABLE IF NOT EXISTS paper_translations (
  arxiv_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (arxiv_id, lang)
);
