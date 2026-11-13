ALTER TABLE "application_attempts" ADD COLUMN "platform" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_attempts" ADD COLUMN "mode" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_attempts" ADD COLUMN "reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_attempts" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "application_attempts" ADD COLUMN "url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_attempts" ADD COLUMN "trigger" text DEFAULT '' NOT NULL;