ALTER TABLE student_cards
  ADD COLUMN IF NOT EXISTS topics_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_transcript_ids BIGINT[] NOT NULL DEFAULT '{}';

