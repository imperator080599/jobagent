CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'upload' NOT NULL,
	"source_file_id" text NOT NULL,
	"docx_file_id" text NOT NULL,
	"preview_file_id" text,
	"pdf_file_id" text,
	"profile" jsonb NOT NULL,
	"baseline" jsonb,
	"master_cv_id" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_user_idx" ON "templates" USING btree ("user_id","kind","is_active");