ALTER TABLE "evaluator_versions"
  ADD COLUMN IF NOT EXISTS "http_display_headers" JSONB;
