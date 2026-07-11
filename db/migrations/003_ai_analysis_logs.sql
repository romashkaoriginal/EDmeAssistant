CREATE TABLE IF NOT EXISTS ai_analysis_logs (
  id BIGSERIAL PRIMARY KEY,
  transcript_id BIGINT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost_usd NUMERIC(12, 8),
  duration_ms INTEGER,
  raw_response TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_analysis_logs_transcript_created_at_idx
  ON ai_analysis_logs (transcript_id, created_at DESC);
