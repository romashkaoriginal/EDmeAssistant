ALTER TABLE tutors ADD COLUMN IF NOT EXISTS my_klass_id TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS my_klass_id TEXT;
ALTER TABLE students ALTER COLUMN grade DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tutors_my_klass_id_unique
  ON tutors (my_klass_id) WHERE my_klass_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS students_my_klass_id_unique
  ON students (my_klass_id) WHERE my_klass_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tutor_students (
  tutor_id BIGINT NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tutor_id, student_id)
);

INSERT INTO tutor_students (tutor_id, student_id)
SELECT tutor_id, id FROM students
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS my_klass_lessons (
  my_klass_lesson_id TEXT PRIMARY KEY,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lesson_date DATE NOT NULL,
  topic TEXT,
  source_payload JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS my_klass_lessons_tutor_date_idx
  ON my_klass_lessons (tutor_id, lesson_date DESC);
