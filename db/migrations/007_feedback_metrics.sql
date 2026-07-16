CREATE TABLE IF NOT EXISTS generation_feedback (
  id BIGSERIAL PRIMARY KEY,
  generation_id BIGINT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  tutor_id BIGINT NOT NULL REFERENCES tutors(id),
  rating TEXT NOT NULL CHECK(rating IN ('up', 'down')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS generation_feedback_generation_idx
  ON generation_feedback (generation_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  tutor_id BIGINT REFERENCES tutors(id),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_events_type_idx
  ON usage_events (event_type, created_at DESC);
