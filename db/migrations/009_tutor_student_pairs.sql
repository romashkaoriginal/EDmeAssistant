-- Subject and grade belong to the tutor-student pair: two tutors can teach
-- the same student different subjects, so the global students row must not
-- be the source of truth for them.
ALTER TABLE tutor_students ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE tutor_students ADD COLUMN IF NOT EXISTS grade INTEGER;

UPDATE tutor_students ts
SET subject = s.subject, grade = s.grade
FROM students s
WHERE s.id = ts.student_id AND ts.subject IS NULL;

-- Lessons are now re-synced after completion (the sync window includes future
-- lessons), so transcript creation needs an explicit once-only flag.
ALTER TABLE my_klass_lessons ADD COLUMN IF NOT EXISTS transcript_created BOOLEAN NOT NULL DEFAULT FALSE;

-- Before this flag a transcript was created at first insert whenever the lesson
-- had a description, so mark those rows as already processed.
UPDATE my_klass_lessons
SET transcript_created = TRUE
WHERE COALESCE(TRIM(source_payload->>'description'), '') <> '';

CREATE INDEX IF NOT EXISTS my_klass_lessons_student_date_idx
  ON my_klass_lessons (student_id, lesson_date DESC);

