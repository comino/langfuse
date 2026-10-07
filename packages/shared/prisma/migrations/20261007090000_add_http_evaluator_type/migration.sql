ALTER TYPE "EvalTemplateType" ADD VALUE IF NOT EXISTS 'HTTP';

ALTER TABLE "evaluator_versions"
  ADD COLUMN IF NOT EXISTS "http_url" TEXT,
  ADD COLUMN IF NOT EXISTS "http_request_headers" JSONB,
  ADD COLUMN IF NOT EXISTS "http_secret_key" TEXT;
