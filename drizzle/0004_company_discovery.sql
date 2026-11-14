ALTER TABLE "companies" ADD COLUMN "ats" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "ats_config" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "board_source_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "discovery" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "discovery_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "origin" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "countries" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "jobs_seen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "last_checked_at" timestamp with time zone;