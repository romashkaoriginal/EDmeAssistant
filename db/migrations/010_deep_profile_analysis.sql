ALTER TABLE student_cards
  ADD COLUMN IF NOT EXISTS topics JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE ai_analysis_logs
  ALTER COLUMN transcript_id DROP NOT NULL;

ALTER TABLE card_history
  DROP CONSTRAINT IF EXISTS card_history_source_check;

ALTER TABLE card_history
  ADD CONSTRAINT card_history_source_check
  CHECK(source IN ('manual', 'transcript', 'moy_klass', 'deep_analysis'));

CREATE TABLE IF NOT EXISTS profile_analysis_drafts (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id),
  changes JSONB NOT NULL,
  source_transcript_ids BIGINT[] NOT NULL DEFAULT '{}',
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS profile_analysis_drafts_student_created_idx
  ON profile_analysis_drafts (student_id, created_at DESC);
