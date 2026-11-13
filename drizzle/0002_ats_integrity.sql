ALTER TABLE "ats_analyses" ADD COLUMN "projected_score" real;--> statement-breakpoint
ALTER TABLE "ats_analyses" ADD COLUMN "request_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ats_analyses" ADD COLUMN "integrity" jsonb;