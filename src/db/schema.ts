// Schéma Postgres (Drizzle). Toutes les tables métier portent un user_id : chaque
// utilisateur dispose d'un espace strictement isolé. Les migrations SQL sont
// générées dans ./drizzle par `npm run db:generate`.
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { CvData } from '../shared/cv.js';
import type { Stage } from '../shared/stages.js';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    return value;
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

type Json = Record<string, unknown>;

// ───────────────────────────── Comptes et sécurité ─────────────────────────────

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    passwordHash: text('password_hash').notNull(),
    role: text('role').$type<'owner' | 'user'>().notNull().default('user'),
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    recoveryCodes: jsonb('recovery_codes').$type<string[]>().notNull().default([]),
    timezone: text('timezone').notNull().default('Europe/Paris'),
    locale: text('locale').notNull().default('fr'),
    disabledAt: ts('disabled_at'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    ip: text('ip').notNull().default(''),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_tokens_hash_uq').on(t.tokenHash)],
);

/** Compteur d'essais (connexion, endpoints sensibles) pour la limitation de débit. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: ts('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: updatedAt(),
});

export const settings = pgTable(
  'settings',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Secrets chiffrés (AES-256-GCM) : clé d'API, mot de passe de messagerie, jetons. */
export const secrets = pgTable(
  'secrets',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    hint: text('hint').notNull().default(''),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Journal d'activité permanent : qui a fait quoi, quand, sur quel objet. */
export const activityLog = pgTable(
  'activity_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    at: ts('at').notNull().defaultNow(),
    actor: text('actor').notNull(),
    level: text('level').$type<'info' | 'warn' | 'error'>().notNull().default('info'),
    entityType: text('entity_type').notNull().default(''),
    entityId: text('entity_id').notNull().default(''),
    action: text('action').notNull(),
    summary: text('summary').notNull().default(''),
    data: jsonb('data').$type<Json>(),
  },
  (t) => [index('activity_user_at_idx').on(t.userId, t.at), index('activity_entity_idx').on(t.entityType, t.entityId)],
);

/** Stockage documentaire : CV source, PDF/DOCX générés, captures, exports. */
export const files = pgTable(
  'files',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    data: bytea('data').notNull(),
    refType: text('ref_type').notNull().default(''),
    refId: text('ref_id').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('files_user_kind_idx').on(t.userId, t.kind), index('files_ref_idx').on(t.refType, t.refId)],
);

// ───────────────────────────── Profil professionnel ─────────────────────────────

export const cvVersions = pgTable(
  'cv_versions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'master' | 'specialized' | 'application'>().notNull(),
    label: text('label').notNull().default(''),
    language: text('language').notNull().default('fr'),
    version: integer('version').notNull().default(1),
    data: jsonb('data').$type<CvData>().notNull(),
    source: text('source').$type<'upload' | 'manual' | 'tailor' | 'linkedin' | 'feedback' | 'translation'>().notNull(),
    parentId: text('parent_id'),
    jobId: text('job_id'),
    status: text('status').$type<'draft' | 'approved' | 'archived'>().notNull().default('draft'),
    /** Un seul master courant par langue ; il n'est remplacé qu'après validation explicite. */
    isCurrent: boolean('is_current').notNull().default(false),
    changeSummary: text('change_summary').notNull().default(''),
    /** Traçabilité : pour chaque élément réécrit, les éléments du master dont il dérive. */
    provenance: jsonb('provenance').$type<Json>(),
    checks: jsonb('checks').$type<Json>(),
    sourceFileId: text('source_file_id'),
    pdfFileId: text('pdf_file_id'),
    docxFileId: text('docx_file_id'),
    createdBy: text('created_by').notNull().default('user'),
    createdAt: createdAt(),
    approvedAt: ts('approved_at'),
  },
  (t) => [
    index('cv_user_kind_idx').on(t.userId, t.kind),
    index('cv_job_idx').on(t.jobId),
    uniqueIndex('cv_current_master_uq')
      .on(t.userId, t.language)
      .where(sql`${t.kind} = 'master' and ${t.isCurrent} = true`),
  ],
);

/**
 * Référentiel personnel : une information validée par clé, avec sa source.
 * Une clé validée n'est jamais redemandée à l'utilisateur.
 */
export const profileFacts = pgTable(
  'profile_facts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull().default(''),
    value: jsonb('value').$type<unknown>().notNull(),
    source: text('source').$type<'cv_master' | 'linkedin' | 'user' | 'document' | 'other'>().notNull().default('user'),
    sourceRef: text('source_ref').notNull().default(''),
    status: text('status').$type<'validated' | 'proposed' | 'rejected' | 'superseded'>().notNull().default('validated'),
    sensitive: boolean('sensitive').notNull().default(false),
    validatedAt: ts('validated_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('facts_user_cat_idx').on(t.userId, t.category),
    uniqueIndex('facts_validated_uq')
      .on(t.userId, t.key)
      .where(sql`${t.status} = 'validated'`),
  ],
);

/** Réponses standards réutilisables pour les formulaires de candidature. */
export const qaAnswers = pgTable(
  'qa_answers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    questionNorm: text('question_norm').notNull(),
    variants: jsonb('variants').$type<string[]>().notNull().default([]),
    answer: text('answer').notNull().default(''),
    answerType: text('answer_type').$type<'text' | 'boolean' | 'choice' | 'number' | 'date'>().notNull().default('text'),
    scope: text('scope').$type<'general' | 'country' | 'company' | 'job'>().notNull().default('general'),
    scopeValue: text('scope_value').notNull().default(''),
    language: text('language').notNull().default(''),
    sensitive: boolean('sensitive').notNull().default(false),
    status: text('status').$type<'validated' | 'pending' | 'rejected'>().notNull().default('validated'),
    source: text('source').$type<'user' | 'derived'>().notNull().default('user'),
    factKey: text('fact_key').notNull().default(''),
    usageCount: integer('usage_count').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('qa_user_idx').on(t.userId),
    uniqueIndex('qa_question_uq').on(t.userId, t.questionNorm, t.scope, t.scopeValue),
  ],
);

export const atsPrompts = pgTable(
  'ats_prompts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    sha256: text('sha256').notNull(),
    note: text('note').notNull().default(''),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ats_prompts_version_uq').on(t.userId, t.version),
    uniqueIndex('ats_prompts_active_uq')
      .on(t.userId)
      .where(sql`${t.isActive} = true`),
  ],
);

export const feedback = pgTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: text('job_id'),
    kind: text('kind').notNull(),
    scope: text('scope').$type<'profile' | 'application' | 'style'>().notNull().default('application'),
    text: text('text').notNull().default(''),
    payload: jsonb('payload').$type<Json>(),
    resolution: jsonb('resolution').$type<Json>(),
    status: text('status').$type<'open' | 'applied' | 'dismissed'>().notNull().default('applied'),
    createdAt: createdAt(),
  },
  (t) => [index('feedback_user_job_idx').on(t.userId, t.jobId)],
);

export const linkedinSnapshots = pgTable(
  'linkedin_snapshots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    method: text('method').$type<'export_zip' | 'profile_pdf' | 'dma_api' | 'paste'>().notNull(),
    data: jsonb('data').$type<CvData>().notNull(),
    contentHash: text('content_hash').notNull(),
    fileId: text('file_id'),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [index('li_user_idx').on(t.userId, t.fetchedAt)],
);

/** Écarts significatifs entre LinkedIn et le CV master, à arbitrer par l'utilisateur. */
export const profileDiffs = pgTable(
  'profile_diffs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    snapshotId: text('snapshot_id').notNull(),
    kind: text('kind').notNull(),
    dedupKey: text('dedup_key').notNull(),
    summary: text('summary').notNull(),
    cvValue: jsonb('cv_value').$type<unknown>(),
    linkedinValue: jsonb('linkedin_value').$type<unknown>(),
    proposal: jsonb('proposal').$type<Json>(),
    status: text('status').$type<'open' | 'accepted' | 'rejected' | 'ignored'>().notNull().default('open'),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('profile_diffs_dedup_uq').on(t.userId, t.dedupKey)],
);

// ───────────────────────────── Recherche d'offres ─────────────────────────────

export const searchProfiles = pgTable(
  'search_profiles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').$type<Json>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('search_profiles_user_idx').on(t.userId)],
);

export const companies = pgTable(
  'companies',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameNorm: text('name_norm').notNull(),
    website: text('website').notNull().default(''),
    careersUrl: text('careers_url').notNull().default(''),
    /** dream = cible prioritaire, target = cible, watch = à surveiller, excluded = jamais. */
    tier: text('tier').$type<'dream' | 'target' | 'watch' | 'excluded'>().notNull().default('target'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('companies_name_uq').on(t.userId, t.nameNorm)],
);

export const sources = pgTable(
  'sources',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Json>().notNull().default({}),
    companyId: text('company_id'),
    enabled: boolean('enabled').notNull().default(true),
    intervalMinutes: integer('interval_minutes').notNull().default(360),
    health: text('health').$type<'unknown' | 'ok' | 'degraded' | 'failing' | 'needs_config'>().notNull().default('unknown'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastRunAt: ts('last_run_at'),
    lastSuccessAt: ts('last_success_at'),
    lastCompleteAt: ts('last_complete_at'),
    lastError: text('last_error').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('sources_user_idx').on(t.userId), uniqueIndex('sources_name_uq').on(t.userId, t.type, t.name)],
);

/** Historique des recherches : une ligne par exécution d'une source. */
export const sourceRuns = pgTable(
  'source_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    trigger: text('trigger').$type<'schedule' | 'manual'>().notNull().default('schedule'),
    status: text('status').$type<'running' | 'complete' | 'partial' | 'failed'>().notNull().default('running'),
    queries: jsonb('queries').$type<unknown[]>().notNull().default([]),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    requests: integer('requests').notNull().default(0),
    itemsSeen: integer('items_seen').notNull().default(0),
    itemsRelevant: integer('items_relevant').notNull().default(0),
    itemsNew: integer('items_new').notNull().default(0),
    itemsUpdated: integer('items_updated').notNull().default(0),
    itemsDuplicate: integer('items_duplicate').notNull().default(0),
    itemsExpired: integer('items_expired').notNull().default(0),
    /** Pourquoi la recherche n'est pas exhaustive, le cas échéant (limite, erreur, quota…). */
    incompleteReason: text('incomplete_reason').notNull().default(''),
    error: text('error').notNull().default(''),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('source_runs_source_idx').on(t.sourceId, t.startedAt), index('source_runs_user_idx').on(t.userId, t.startedAt)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Empreinte entreprise + intitulé + lieu normalisés : clé de rapprochement entre plateformes. */
    fingerprint: text('fingerprint').notNull(),
    canonicalUrl: text('canonical_url').notNull().default(''),
    applyUrl: text('apply_url').notNull().default(''),
    externalRef: text('external_ref').notNull().default(''),
    companyId: text('company_id'),
    companyName: text('company_name').notNull(),
    companyNorm: text('company_norm').notNull(),
    title: text('title').notNull(),
    titleNorm: text('title_norm').notNull(),
    locationRaw: text('location_raw').notNull().default(''),
    country: text('country').notNull().default(''),
    city: text('city').notNull().default(''),
    remote: text('remote').$type<'' | 'onsite' | 'hybrid' | 'remote'>().notNull().default(''),
    contractType: text('contract_type').notNull().default(''),
    seniority: text('seniority').notNull().default(''),
    yearsMin: real('years_min'),
    yearsMax: real('years_max'),
    department: text('department').notNull().default(''),
    language: text('language').notNull().default(''),
    postedAt: ts('posted_at'),
    deadlineAt: ts('deadline_at'),
    descriptionText: text('description_text').notNull().default(''),
    descriptionHash: text('description_hash').notNull().default(''),
    salaryMin: doublePrecision('salary_min'),
    salaryMax: doublePrecision('salary_max'),
    salaryCurrency: text('salary_currency').notNull().default(''),
    salaryPeriod: text('salary_period').notNull().default(''),

    stage: text('stage').$type<Stage>().notNull().default('new'),
    stageChangedAt: ts('stage_changed_at').notNull().defaultNow(),

    /** Intérêt de l'opportunité pour la carrière (0-100) — distinct de l'adéquation. */
    relevanceScore: real('relevance_score'),
    /** Adéquation du profil avec les exigences du poste (0-100). */
    fitScore: real('fit_score'),
    /** Priorité de candidature (0-100), combinaison pondérée et configurable. */
    priorityScore: real('priority_score'),
    strategic: boolean('strategic').notNull().default(false),
    qualification: jsonb('qualification').$type<Json>(),
    qualifiedAt: ts('qualified_at'),
    qualificationMethod: text('qualification_method').notNull().default(''),

    atsScore: real('ats_score'),
    atsDecision: text('ats_decision').notNull().default(''),
    latestAnalysisId: text('latest_analysis_id'),

    flags: jsonb('flags').$type<Json>().notNull().default({}),
    userDecision: text('user_decision').notNull().default(''),
    userDecidedAt: ts('user_decided_at'),
    starred: boolean('starred').notNull().default(false),
    notes: text('notes').notNull().default(''),

    sourcesCount: integer('sources_count').notNull().default(1),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiredAt: ts('expired_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_user_stage_idx').on(t.userId, t.stage),
    index('jobs_user_fp_idx').on(t.userId, t.fingerprint),
    index('jobs_user_company_idx').on(t.userId, t.companyNorm),
    index('jobs_user_priority_idx').on(t.userId, t.priorityScore),
    index('jobs_user_seen_idx').on(t.userId, t.firstSeenAt),
    uniqueIndex('jobs_canonical_uq')
      .on(t.userId, t.canonicalUrl)
      .where(sql`${t.canonicalUrl} <> ''`),
  ],
);

/** Une « observation » d'une offre sur une source : permet de suivre les multi-diffusions et les disparitions. */
export const jobSightings = pgTable(
  'job_sightings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url').notNull().default(''),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    lastRunId: text('last_run_id').notNull().default(''),
    goneAt: ts('gone_at'),
  },
  (t) => [uniqueIndex('sightings_source_ext_uq').on(t.sourceId, t.externalId), index('sightings_job_idx').on(t.jobId)],
);

export const stageHistory = pgTable(
  'stage_history',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    fromStage: text('from_stage').notNull(),
    toStage: text('to_stage').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull().default(''),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('stage_history_job_idx').on(t.jobId, t.at)],
);

// ───────────────────────────── IA ─────────────────────────────

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    status: text('status').notNull().default('ok'),
    stopReason: text('stop_reason').notNull().default(''),
    error: text('error').notNull().default(''),
    jobId: text('job_id'),
    createdAt: createdAt(),
  },
  (t) => [index('llm_calls_user_at_idx').on(t.userId, t.createdAt)],
);

export const atsAnalyses = pgTable(
  'ats_analyses',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    cvVersionId: text('cv_version_id').notNull(),
    promptId: text('prompt_id').notNull(),
    promptSha: text('prompt_sha').notNull(),
    /** Empreinte (CV + prompt + offre + précisions) : une même analyse n'est jamais payée deux fois. */
    inputHash: text('input_hash').notNull(),
    model: text('model').notNull(),
    /** Sortie intégrale du prompt ATS de l'utilisateur, conservée telle quelle. */
    rawOutput: text('raw_output').notNull(),
    /** Synthèse structurée extraite de la sortie (jamais substituée à l'original). */
    parsed: jsonb('parsed').$type<Json>(),
    score: real('score'),
    decision: text('decision').notNull().default(''),
    userNote: text('user_note').notNull().default(''),
    status: text('status').$type<'ok' | 'failed' | 'refused'>().notNull().default('ok'),
    createdAt: createdAt(),
  },
  (t) => [index('ats_job_idx').on(t.jobId, t.createdAt), index('ats_hash_idx').on(t.userId, t.inputHash)],
);

export const letters = pgTable(
  'letters',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'template' | 'application'>().notNull().default('application'),
    jobId: text('job_id'),
    cvVersionId: text('cv_version_id'),
    language: text('language').notNull().default('fr'),
    content: jsonb('content').$type<Json>().notNull(),
    text: text('text').notNull().default(''),
    status: text('status').$type<'draft' | 'approved' | 'archived'>().notNull().default('draft'),
    checks: jsonb('checks').$type<Json>(),
    pdfFileId: text('pdf_file_id'),
    docxFileId: text('docx_file_id'),
    parentId: text('parent_id'),
    createdBy: text('created_by').notNull().default('agent:letter'),
    createdAt: createdAt(),
    approvedAt: ts('approved_at'),
  },
  (t) => [index('letters_job_idx').on(t.jobId), index('letters_user_idx').on(t.userId, t.kind)],
);

// ───────────────────────────── Candidatures ─────────────────────────────

export const applications = pgTable(
  'applications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    cvVersionId: text('cv_version_id'),
    letterId: text('letter_id'),
    mode: text('mode').$type<'manual' | 'assisted' | 'auto'>().notNull().default('manual'),
    channel: text('channel').notNull().default(''),
    applyUrl: text('apply_url').notNull().default(''),
    qaReport: jsonb('qa_report').$type<Json>(),
    answersSnapshot: jsonb('answers_snapshot').$type<Json>(),
    preparedAt: ts('prepared_at'),
    authorizedAt: ts('authorized_at'),
    authorizedBy: text('authorized_by').notNull().default(''),
    submittedAt: ts('submitted_at'),
    /** Preuve de réception : texte de confirmation, URL, capture, email rapproché. */
    confirmation: jsonb('confirmation').$type<Json>(),
    confirmedAt: ts('confirmed_at'),
    lastActivityAt: ts('last_activity_at'),
    followUpDueAt: ts('follow_up_due_at'),
    followUpCount: integer('follow_up_count').notNull().default(0),
    outcome: text('outcome').notNull().default(''),
    outcomeAt: ts('outcome_at'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Une seule candidature par offre : garde-fou anti-doublon au niveau de la base.
  (t) => [uniqueIndex('applications_job_uq').on(t.userId, t.jobId)],
);

export const applicationAttempts = pgTable(
  'application_attempts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    driver: text('driver').$type<'browser' | 'extension' | 'manual'>().notNull().default('browser'),
    dryRun: boolean('dry_run').notNull().default(false),
    status: text('status').notNull().default('started'),
    steps: jsonb('steps').$type<unknown[]>().notNull().default([]),
    fields: jsonb('fields').$type<unknown[]>().notNull().default([]),
    error: text('error').notNull().default(''),
    screenshotFileIds: jsonb('screenshot_file_ids').$type<string[]>().notNull().default([]),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('attempts_app_idx').on(t.applicationId, t.startedAt)],
);

/** Centre de validation : tout ce qui requiert l'intervention de l'utilisateur. */
export const actionItems = pgTable(
  'action_items',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: jsonb('body').$type<Json>().notNull().default({}),
    jobId: text('job_id'),
    applicationId: text('application_id'),
    priority: integer('priority').notNull().default(50),
    status: text('status').$type<'open' | 'done' | 'dismissed' | 'snoozed'>().notNull().default('open'),
    snoozeUntil: ts('snooze_until'),
    /** Clé d'unicité : une même question n'est jamais posée deux fois. */
    dedupKey: text('dedup_key').notNull(),
    resolution: jsonb('resolution').$type<Json>(),
    createdAt: createdAt(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [uniqueIndex('action_items_dedup_uq').on(t.userId, t.dedupKey), index('action_items_open_idx').on(t.userId, t.status, t.priority)],
);

// ───────────────────────────── File de tâches et planification ─────────────────────────────

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Json>().notNull().default({}),
    status: text('status').$type<'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled'>().notNull().default('queued'),
    priority: integer('priority').notNull().default(50),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(4),
    runAfter: ts('run_after').notNull().defaultNow(),
    lockedAt: ts('locked_at'),
    lockedBy: text('locked_by').notNull().default(''),
    /** Clé d'idempotence : une seule tâche active par clé (reprise sans doublon). */
    idempotencyKey: text('idempotency_key'),
    lastError: text('last_error').notNull().default(''),
    result: jsonb('result').$type<Json>(),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('tasks_claim_idx').on(t.status, t.runAfter, t.priority),
    index('tasks_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('tasks_idem_active_uq')
      .on(t.idempotencyKey)
      .where(sql`${t.status} in ('queued', 'running', 'blocked')`),
  ],
);

export const scheduleState = pgTable(
  'schedule_state',
  {
    scope: text('scope').notNull(),
    name: text('name').notNull(),
    lastRunAt: ts('last_run_at'),
    data: jsonb('data').$type<Json>(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.name] })],
);

// ───────────────────────────── Suivi : emails, entretiens, contacts ─────────────────────────────

export const emails = pgTable(
  'emails',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    threadKey: text('thread_key').notNull().default(''),
    fromAddr: text('from_addr').notNull().default(''),
    fromName: text('from_name').notNull().default(''),
    subject: text('subject').notNull().default(''),
    date: ts('date'),
    snippet: text('snippet').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    category: text('category').notNull().default(''),
    confidence: real('confidence'),
    applicationId: text('application_id'),
    jobId: text('job_id'),
    matchMethod: text('match_method').notNull().default(''),
    extracted: jsonb('extracted').$type<Json>(),
    needsReview: boolean('needs_review').notNull().default(false),
    processedAt: ts('processed_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('emails_msgid_uq').on(t.userId, t.messageId), index('emails_user_date_idx').on(t.userId, t.date)],
);

export const drafts = pgTable(
  'drafts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'reply' | 'follow_up' | 'thank_you' | 'outreach'>().notNull(),
    jobId: text('job_id'),
    applicationId: text('application_id'),
    emailId: text('email_id'),
    contactId: text('contact_id'),
    toAddr: text('to_addr').notNull().default(''),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull().default(''),
    language: text('language').notNull().default('fr'),
    status: text('status').$type<'draft' | 'approved' | 'sent' | 'discarded'>().notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('drafts_user_idx').on(t.userId, t.status)],
);

export const interviews = pgTable(
  'interviews',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    applicationId: text('application_id'),
    kind: text('kind').$type<'hr' | 'technical' | 'case' | 'partner' | 'other'>().notNull().default('hr'),
    scheduledAt: ts('scheduled_at'),
    durationMin: integer('duration_min').notNull().default(60),
    location: text('location').notNull().default(''),
    meetingUrl: text('meeting_url').notNull().default(''),
    interviewer: text('interviewer').notNull().default(''),
    status: text('status').$type<'to_schedule' | 'scheduled' | 'done' | 'cancelled'>().notNull().default('to_schedule'),
    prep: jsonb('prep').$type<Json>(),
    prepStatus: text('prep_status').notNull().default(''),
    userFeedback: text('user_feedback').notNull().default(''),
    sourceEmailId: text('source_email_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('interviews_user_idx').on(t.userId, t.scheduledAt)],
);

export const contacts = pgTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: text('company_id'),
    jobId: text('job_id'),
    name: text('name').notNull(),
    role: text('role').notNull().default(''),
    relationship: text('relationship').notNull().default(''),
    linkedinUrl: text('linkedin_url').notNull().default(''),
    email: text('email').notNull().default(''),
    source: text('source').notNull().default('user'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('contacts_user_idx').on(t.userId)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    kind: text('kind').notNull(),
    dedupKey: text('dedup_key').notNull(),
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    status: text('status').$type<'sent' | 'failed' | 'skipped'>().notNull().default('sent'),
    error: text('error').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('notifications_dedup_uq').on(t.userId, t.channel, t.dedupKey)],
);

export const evalRuns = pgTable('eval_runs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  suite: text('suite').notNull(),
  label: text('label').notNull().default(''),
  metrics: jsonb('metrics').$type<Json>().notNull(),
  details: jsonb('details').$type<Json>(),
  createdAt: createdAt(),
});
