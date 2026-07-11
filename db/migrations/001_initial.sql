CREATE TABLE IF NOT EXISTS tutors (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  telegram_id TEXT UNIQUE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'tutor',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  grade INTEGER NOT NULL,
  my_class_id TEXT,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id),
  status TEXT NOT NULL DEFAULT 'active',
  last_lesson_at DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS student_cards (
  student_id BIGINT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  current_level TEXT,
  strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  weaknesses JSONB NOT NULL DEFAULT '[]'::jsonb,
  gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  learning_goal TEXT,
  learning_pace TEXT,
  features TEXT,
  next_lesson_plan TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id),
  lesson_date DATE NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'analyzed', 'approved', 'rejected')),
  analysis_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analysis_drafts (
  id BIGSERIAL PRIMARY KEY,
  transcript_id BIGINT NOT NULL UNIQUE REFERENCES transcripts(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id),
  changes JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS card_history (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id),
  source TEXT NOT NULL CHECK(source IN ('manual', 'transcript', 'moy_klass')),
  changes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mts_link_sessions (
  event_session_id TEXT PRIMARY KEY,
  my_klass_lesson_id TEXT UNIQUE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mts_link_webhooks (
  transcript_id TEXT PRIMARY KEY,
  event_session_id TEXT NOT NULL,
  local_transcript_id BIGINT REFERENCES transcripts(id),
  status TEXT NOT NULL CHECK(status IN ('received', 'synced', 'unmapped', 'failed')),
  raw_payload JSONB NOT NULL,
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
