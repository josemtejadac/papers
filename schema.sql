-- Esquema D1 para el feed de Social compartido de Lab · Papers.
-- Ejecutar una sola vez contra la base D1 del proyecto (ver SETUP-SOCIAL-DB.md).

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_name TEXT NOT NULL,
  author_sub TEXT,
  text TEXT NOT NULL,
  paper_id TEXT,
  quoted_post_id TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  quotes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (post_id, device_id)
);

-- Datos iniciales (las mismas 3 publicaciones de ejemplo que traía el prototipo en memoria)
INSERT OR IGNORE INTO posts (id, author_name, author_sub, text, paper_id, likes, replies, quotes, created_at) VALUES
('s1', 'Ana Beltrán', 'Neurociencia',
 '¿Alguien más piensa que el etiquetado sináptico durante REM podría generalizar a aprendizaje motor? No veo por qué se limitaría a tareas espaciales.',
 'p2', 14, 3, 1, datetime('now', '-3 hours')),
('s2', 'Marina Rojas', 'Inmunología · mismo laboratorio',
 'Terminé de leer el paper de GNN para plegado de proteínas. El salto en dominios cortos es real, pero dudo que escale a proteínas de membrana sin más datos.',
 'p1', 9, 5, 0, datetime('now', '-5 hours')),
('s3', 'Tomás Ibarra', 'Teoría · aprendizaje por refuerzo',
 'La cota de complejidad de muestra offline es elegante, pero en la práctica seguimos sin saber cuánta cobertura parcial es "suficiente". ¿Alguien la probó con datasets reales?',
 'p3', 6, 2, 0, datetime('now', '-8 hours'));
