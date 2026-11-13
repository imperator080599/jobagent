// Registre des paramètres utilisateur : schéma de validation + valeur par défaut.
// Tout ce qui pilote le comportement du système est ici, modifiable depuis
// l'interface sans toucher au code.
import { z } from 'zod';

const Channel = z.object({ enabled: z.boolean().default(false) });

export const SETTINGS = {
  /** Mode de candidature : validation (récapitulatif avant envoi) ou autonome (envoi automatique sous conditions). */
  'application.mode': {
    schema: z.enum(['validation', 'autonomous']),
    default: 'validation' as const,
  },
  /** Conditions du mode autonome. Ne dispense jamais de disposer de réponses validées. */
  'application.autonomous': {
    schema: z.object({
      minAtsScore: z.number().min(0).max(20),
      minPriority: z.number().min(0).max(100),
      maxPerDay: z.number().int().min(0).max(50),
      autoApproveDocuments: z.boolean(),
    }),
    default: { minAtsScore: 15, minPriority: 70, maxPerDay: 5, autoApproveDocuments: false },
  },
  /** Mode TEST : tout est préparé, rien n'est réellement soumis ni envoyé. */
  'application.dryRun': { schema: z.boolean(), default: false },
  'ats.thresholds': {
    schema: z.object({ excellent: z.number(), interesting: z.number(), limited: z.number() }),
    default: { excellent: 15, interesting: 13, limited: 11 },
  },
  /** Maîtrise du coût : seuil de pertinence et plafond quotidien d'analyses ATS. */
  'ats.policy': {
    schema: z.object({
      minRelevance: z.number().min(0).max(100),
      maxPerDay: z.number().int().min(0).max(200),
      requestFeedbackFrom: z.number().min(0).max(20),
    }),
    default: { minRelevance: 60, maxPerDay: 12, requestFeedbackFrom: 11 },
  },
  /** Pondération de la priorité de candidature (l'intérêt carrière pèse plus que l'adéquation immédiate). */
  'scoring.weights': {
    schema: z.object({ relevance: z.number(), fit: z.number(), freshness: z.number() }),
    default: { relevance: 0.55, fit: 0.3, freshness: 0.15 },
  },
  'llm.models': {
    schema: z.object({ main: z.string().min(1), bulk: z.string().min(1) }),
    default: { main: 'claude-opus-5-5', bulk: 'claude-haiku-5-5' },
  },
  'llm.budget': {
    schema: z.object({ monthlyUsd: z.number().min(0), dailyUsd: z.number().min(0) }),
    default: { monthlyUsd: 40, dailyUsd: 4 },
  },
  'schedule.search': {
    schema: z.object({ enabled: z.boolean(), intervalHours: z.number().min(1).max(168) }),
    default: { enabled: true, intervalHours: 6 },
  },
  'schedule.digest': {
    schema: z.object({ enabled: z.boolean(), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
    default: { enabled: true, hour: 8, minute: 0 },
  },
  'schedule.email': {
    schema: z.object({ enabled: z.boolean(), intervalMinutes: z.number().int().min(5).max(1440) }),
    default: { enabled: false, intervalMinutes: 30 },
  },
  'email.imap': {
    schema: z.object({
      host: z.string(),
      port: z.number().int(),
      secure: z.boolean(),
      user: z.string(),
      folder: z.string(),
      alertFolders: z.array(z.string()),
    }),
    default: { host: '', port: 993, secure: true, user: '', folder: 'INBOX', alertFolders: [] as string[] },
  },
  'email.smtp': {
    schema: z.object({ host: z.string(), port: z.number().int(), secure: z.boolean(), user: z.string(), from: z.string() }),
    default: { host: '', port: 465, secure: true, user: '', from: '' },
  },
  /** Connexion Gmail par OAuth. Lecture et rédaction sont deux autorisations distinctes ; l'envoi reste désactivé par défaut. */
  'email.gmail': {
    schema: z.object({
      clientId: z.string(),
      /** Adresse du compte connecté (renseignée par la connexion). */
      account: z.string(),
      /** Autorisations réellement accordées par Google. */
      canRead: z.boolean(),
      canCompose: z.boolean(),
      connectedAt: z.string(),
      /** Autorise l'envoi d'un brouillon sur clic explicite. Jamais d'envoi automatique. */
      allowSend: z.boolean(),
      /** Profondeur de la première lecture, en jours. */
      lookbackDays: z.number().int().min(1).max(180),
      /** Importer aussi les alertes d'offres reçues par email. */
      importAlerts: z.boolean(),
    }),
    default: { clientId: '', account: '', canRead: false, canCompose: false, connectedAt: '', allowSend: false, lookbackDays: 30, importAlerts: true },
  },
  'notifications.channels': {
    schema: z.object({
      email: Channel.extend({ to: z.string().default('') }),
      telegram: Channel.extend({ chatId: z.string().default('') }),
      ntfy: Channel.extend({ server: z.string().default('https://ntfy.sh'), topic: z.string().default('') }),
      webhook: Channel.extend({ url: z.string().default('') }),
    }),
    default: {
      email: { enabled: false, to: '' },
      telegram: { enabled: false, chatId: '' },
      ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
      webhook: { enabled: false, url: '' },
    },
  },
  /** Événements notifiés immédiatement ; tout le reste passe par le résumé quotidien. */
  'notifications.immediate': {
    schema: z.array(z.string()),
    default: ['interview', 'offer', 'recruiter_request', 'source_down', 'budget_reached'],
  },
  'followup.rules': {
    schema: z.object({
      firstAfterDays: z.number().int().min(1),
      secondAfterDays: z.number().int().min(1),
      noResponseAfterDays: z.number().int().min(1),
    }),
    default: { firstAfterDays: 10, secondAfterDays: 21, noResponseAfterDays: 45 },
  },
  'linkedin.sync': {
    schema: z.object({ enabled: z.boolean(), intervalDays: z.number().int().min(1), autoApplyFactual: z.boolean() }),
    default: { enabled: false, intervalDays: 7, autoApplyFactual: false },
  },
  'documents.cv': {
    schema: z.object({ maxPages: z.number().int().min(1).max(3), template: z.enum(['classic', 'compact']), font: z.string() }),
    default: { maxPages: 1, template: 'classic' as const, font: 'serif' },
  },
  'ui.onboarding': {
    schema: z.object({ dismissed: z.boolean() }),
    default: { dismissed: false },
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTINGS;
}
