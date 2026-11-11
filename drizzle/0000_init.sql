CREATE TABLE "action_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"job_id" text,
	"application_id" text,
	"priority" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"snooze_until" timestamp with time zone,
	"dedup_key" text NOT NULL,
	"resolution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"entity_type" text DEFAULT '' NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"driver" text DEFAULT 'browser' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"screenshot_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"job_id" text NOT NULL,
	"cv_version_id" text,
	"letter_id" text,
	"mode" text DEFAULT 'manual' NOT NULL,
	"channel" text DEFAULT '' NOT NULL,
	"apply_url" text DEFAULT '' NOT NULL,
	"qa_report" jsonb,
	"answers_snapshot" jsonb,
	"prepared_at" timestamp with time zone,
	"authorized_at" timestamp with time zone,
	"authorized_by" text DEFAULT '' NOT NULL,
	"submitted_at" timestamp with time zone,
	"confirmation" jsonb,
	"confirmed_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"follow_up_due_at" timestamp with time zone,
	"follow_up_count" integer DEFAULT 0 NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"outcome_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ats_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"job_id" text NOT NULL,
	"cv_version_id" text NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt_sha" text NOT NULL,
	"input_hash" text NOT NULL,
	"model" text NOT NULL,
	"raw_output" text NOT NULL,
	"parsed" jsonb,
	"score" real,
	"decision" text DEFAULT '' NOT NULL,
	"user_note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ats_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"name_norm" text NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"careers_url" text DEFAULT '' NOT NULL,
	"tier" text DEFAULT 'target' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text,
	"job_id" text,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"relationship" text DEFAULT '' NOT NULL,
	"linkedin_url" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cv_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'fr' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"source" text NOT NULL,
	"parent_id" text,
	"job_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"change_summary" text DEFAULT '' NOT NULL,
	"provenance" jsonb,
	"checks" jsonb,
	"source_file_id" text,
	"pdf_file_id" text,
	"docx_file_id" text,
	"created_by" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"job_id" text,
	"application_id" text,
	"email_id" text,
	"contact_id" text,
	"to_addr" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'fr' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_key" text DEFAULT '' NOT NULL,
	"from_addr" text DEFAULT '' NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"date" timestamp with time zone,
	"snippet" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"confidence" real,
	"application_id" text,
	"job_id" text,
	"match_method" text DEFAULT '' NOT NULL,
	"extracted" jsonb,
	"needs_review" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"suite" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"metrics" jsonb NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"job_id" text,
	"kind" text NOT NULL,
	"scope" text DEFAULT 'application' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"payload" jsonb,
	"resolution" jsonb,
	"status" text DEFAULT 'applied' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"ref_type" text DEFAULT '' NOT NULL,
	"ref_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"job_id" text NOT NULL,
	"application_id" text,
	"kind" text DEFAULT 'hr' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"duration_min" integer DEFAULT 60 NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"meeting_url" text DEFAULT '' NOT NULL,
	"interviewer" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'to_schedule' NOT NULL,
	"prep" jsonb,
	"prep_status" text DEFAULT '' NOT NULL,
	"user_feedback" text DEFAULT '' NOT NULL,
	"source_email_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_sightings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"job_id" text NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_id" text DEFAULT '' NOT NULL,
	"gone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"canonical_url" text DEFAULT '' NOT NULL,
	"apply_url" text DEFAULT '' NOT NULL,
	"external_ref" text DEFAULT '' NOT NULL,
	"company_id" text,
	"company_name" text NOT NULL,
	"company_norm" text NOT NULL,
	"title" text NOT NULL,
	"title_norm" text NOT NULL,
	"location_raw" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"remote" text DEFAULT '' NOT NULL,
	"contract_type" text DEFAULT '' NOT NULL,
	"seniority" text DEFAULT '' NOT NULL,
	"years_min" real,
	"years_max" real,
	"department" text DEFAULT '' NOT NULL,
	"language" text DEFAULT '' NOT NULL,
	"posted_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"description_text" text DEFAULT '' NOT NULL,
	"description_hash" text DEFAULT '' NOT NULL,
	"salary_min" double precision,
	"salary_max" double precision,
	"salary_currency" text DEFAULT '' NOT NULL,
	"salary_period" text DEFAULT '' NOT NULL,
	"stage" text DEFAULT 'new' NOT NULL,
	"stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relevance_score" real,
	"fit_score" real,
	"priority_score" real,
	"strategic" boolean DEFAULT false NOT NULL,
	"qualification" jsonb,
	"qualified_at" timestamp with time zone,
	"qualification_method" text DEFAULT '' NOT NULL,
	"ats_score" real,
	"ats_decision" text DEFAULT '' NOT NULL,
	"latest_analysis_id" text,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"user_decision" text DEFAULT '' NOT NULL,
	"user_decided_at" timestamp with time zone,
	"starred" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"sources_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "letters" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'application' NOT NULL,
	"job_id" text,
	"cv_version_id" text,
	"language" text DEFAULT 'fr' NOT NULL,
	"content" jsonb NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"checks" jsonb,
	"pdf_file_id" text,
	"docx_file_id" text,
	"parent_id" text,
	"created_by" text DEFAULT 'agent:letter' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "linkedin_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"method" text NOT NULL,
	"data" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"file_id" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"stop_reason" text DEFAULT '' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"dedup_key" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_diffs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"kind" text NOT NULL,
	"dedup_key" text NOT NULL,
	"summary" text NOT NULL,
	"cv_value" jsonb,
	"linkedin_value" jsonb,
	"proposal" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"value" jsonb NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"source_ref" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'validated' NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"question" text NOT NULL,
	"question_norm" text NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"answer_type" text DEFAULT 'text' NOT NULL,
	"scope" text DEFAULT 'general' NOT NULL,
	"scope_value" text DEFAULT '' NOT NULL,
	"language" text DEFAULT '' NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'validated' NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"fact_key" text DEFAULT '' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "schedule_state" (
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"data" jsonb,
	CONSTRAINT "schedule_state_scope_name_pk" PRIMARY KEY("scope","name")
);
--> statement-breakpoint
CREATE TABLE "search_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "source_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_id" text NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"queries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_relevant" integer DEFAULT 0 NOT NULL,
	"items_new" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"items_duplicate" integer DEFAULT 0 NOT NULL,
	"items_expired" integer DEFAULT 0 NOT NULL,
	"incomplete_reason" text DEFAULT '' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"company_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 360 NOT NULL,
	"health" text DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_complete_at" timestamp with time zone,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_history" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"job_id" text NOT NULL,
	"from_stage" text NOT NULL,
	"to_stage" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 4 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text DEFAULT '' NOT NULL,
	"idempotency_key" text,
	"last_error" text DEFAULT '' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"recovery_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timezone" text DEFAULT 'Europe/Paris' NOT NULL,
	"locale" text DEFAULT 'fr' NOT NULL,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_attempts" ADD CONSTRAINT "application_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_attempts" ADD CONSTRAINT "application_attempts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_analyses" ADD CONSTRAINT "ats_analyses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_analyses" ADD CONSTRAINT "ats_analyses_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_prompts" ADD CONSTRAINT "ats_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_versions" ADD CONSTRAINT "cv_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sightings" ADD CONSTRAINT "job_sightings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sightings" ADD CONSTRAINT "job_sightings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letters" ADD CONSTRAINT "letters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_snapshots" ADD CONSTRAINT "linkedin_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_diffs" ADD CONSTRAINT "profile_diffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_answers" ADD CONSTRAINT "qa_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_profiles" ADD CONSTRAINT "search_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_items_dedup_uq" ON "action_items" USING btree ("user_id","dedup_key");--> statement-breakpoint
CREATE INDEX "action_items_open_idx" ON "action_items" USING btree ("user_id","status","priority");--> statement-breakpoint
CREATE INDEX "activity_user_at_idx" ON "activity_log" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "activity_entity_idx" ON "activity_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_uq" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "attempts_app_idx" ON "application_attempts" USING btree ("application_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_job_uq" ON "applications" USING btree ("user_id","job_id");--> statement-breakpoint
CREATE INDEX "ats_job_idx" ON "ats_analyses" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "ats_hash_idx" ON "ats_analyses" USING btree ("user_id","input_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ats_prompts_version_uq" ON "ats_prompts" USING btree ("user_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ats_prompts_active_uq" ON "ats_prompts" USING btree ("user_id") WHERE "ats_prompts"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_name_uq" ON "companies" USING btree ("user_id","name_norm");--> statement-breakpoint
CREATE INDEX "contacts_user_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cv_user_kind_idx" ON "cv_versions" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "cv_job_idx" ON "cv_versions" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cv_current_master_uq" ON "cv_versions" USING btree ("user_id","language") WHERE "cv_versions"."kind" = 'master' and "cv_versions"."is_current" = true;--> statement-breakpoint
CREATE INDEX "drafts_user_idx" ON "drafts" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_msgid_uq" ON "emails" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "emails_user_date_idx" ON "emails" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "feedback_user_job_idx" ON "feedback" USING btree ("user_id","job_id");--> statement-breakpoint
CREATE INDEX "files_user_kind_idx" ON "files" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "files_ref_idx" ON "files" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "interviews_user_idx" ON "interviews" USING btree ("user_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sightings_source_ext_uq" ON "job_sightings" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "sightings_job_idx" ON "job_sightings" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_user_stage_idx" ON "jobs" USING btree ("user_id","stage");--> statement-breakpoint
CREATE INDEX "jobs_user_fp_idx" ON "jobs" USING btree ("user_id","fingerprint");--> statement-breakpoint
CREATE INDEX "jobs_user_company_idx" ON "jobs" USING btree ("user_id","company_norm");--> statement-breakpoint
CREATE INDEX "jobs_user_priority_idx" ON "jobs" USING btree ("user_id","priority_score");--> statement-breakpoint
CREATE INDEX "jobs_user_seen_idx" ON "jobs" USING btree ("user_id","first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_canonical_uq" ON "jobs" USING btree ("user_id","canonical_url") WHERE "jobs"."canonical_url" <> '';--> statement-breakpoint
CREATE INDEX "letters_job_idx" ON "letters" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "letters_user_idx" ON "letters" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "li_user_idx" ON "linkedin_snapshots" USING btree ("user_id","fetched_at");--> statement-breakpoint
CREATE INDEX "llm_calls_user_at_idx" ON "llm_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedup_uq" ON "notifications" USING btree ("user_id","channel","dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_diffs_dedup_uq" ON "profile_diffs" USING btree ("user_id","dedup_key");--> statement-breakpoint
CREATE INDEX "facts_user_cat_idx" ON "profile_facts" USING btree ("user_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "facts_validated_uq" ON "profile_facts" USING btree ("user_id","key") WHERE "profile_facts"."status" = 'validated';--> statement-breakpoint
CREATE INDEX "qa_user_idx" ON "qa_answers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_question_uq" ON "qa_answers" USING btree ("user_id","question_norm","scope","scope_value");--> statement-breakpoint
CREATE INDEX "search_profiles_user_idx" ON "search_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "source_runs_source_idx" ON "source_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "source_runs_user_idx" ON "source_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "sources_user_idx" ON "sources" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_name_uq" ON "sources" USING btree ("user_id","type","name");--> statement-breakpoint
CREATE INDEX "stage_history_job_idx" ON "stage_history" USING btree ("job_id","at");--> statement-breakpoint
CREATE INDEX "tasks_claim_idx" ON "tasks" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE INDEX "tasks_user_idx" ON "tasks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idem_active_uq" ON "tasks" USING btree ("idempotency_key") WHERE "tasks"."status" in ('queued', 'running', 'blocked');--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");