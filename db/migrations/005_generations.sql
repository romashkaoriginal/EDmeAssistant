CREATE TABLE IF NOT EXISTS generations (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('homework', 'test', 'tasks')),
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id),
  topic TEXT NOT NULL,
  input_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  result TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'saved')),
  parent_id BIGINT REFERENCES generations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS generations_student_idx
  ON generations (student_id, created_at DESC);
