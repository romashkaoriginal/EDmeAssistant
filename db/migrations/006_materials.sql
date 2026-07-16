CREATE TABLE IF NOT EXISTS materials (
  id BIGSERIAL PRIMARY KEY,
  mts_file_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('grade', 'ct_ce')),
  grade INTEGER,
  subject TEXT NOT NULL,
  topic TEXT,
  material_type TEXT NOT NULL,
  url TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS materials_search_idx
  ON materials (subject, grade);
