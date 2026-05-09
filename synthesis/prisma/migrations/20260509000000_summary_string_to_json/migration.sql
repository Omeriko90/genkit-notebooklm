ALTER TABLE "newsletter_history"
  ALTER COLUMN "summary" TYPE JSONB USING summary::jsonb;
