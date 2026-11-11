// Statuts du pipeline d'une opportunité. Partagé entre le serveur et l'interface.
// Les 17 statuts demandés + deux statuts techniques (« filtered », « expired ») pour
// les offres qui n'entrent jamais dans l'entonnoir de candidature.

export const STAGES = [
  'new',
  'to_analyze',
  'analyzed',
  'awaiting_feedback',
  'cv_in_progress',
  'letter_in_progress',
  'ready_to_apply',
  'applying',
  'sent',
  'confirmed',
  'interview_hr',
  'interview_tech',
  'offer',
  'rejected',
  'no_response',
  'follow_up_needed',
  'abandoned',
  'filtered',
  'expired',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'Nouvelle offre',
  to_analyze: 'À analyser',
  analyzed: 'Analyse terminée',
  awaiting_feedback: 'En attente de feedback',
  cv_in_progress: 'CV en préparation',
  letter_in_progress: 'Lettre en préparation',
  ready_to_apply: 'Prête à candidater',
  applying: 'Candidature en cours',
  sent: 'Envoyée',
  confirmed: 'Confirmation reçue',
  interview_hr: 'Entretien RH',
  interview_tech: 'Entretien technique',
  offer: 'Offre reçue',
  rejected: 'Refus',
  no_response: 'Sans réponse',
  follow_up_needed: 'Relance nécessaire',
  abandoned: 'Abandonnée',
  filtered: 'Écartée (hors cible)',
  expired: 'Expirée',
};

/** Regroupements utilisés par le tableau de bord et les filtres. */
export const STAGE_GROUPS = {
  discovery: ['new', 'to_analyze', 'analyzed'] as Stage[],
  decision: ['awaiting_feedback'] as Stage[],
  preparation: ['cv_in_progress', 'letter_in_progress', 'ready_to_apply', 'applying'] as Stage[],
  submitted: ['sent', 'confirmed', 'follow_up_needed', 'no_response'] as Stage[],
  interviews: ['interview_hr', 'interview_tech'] as Stage[],
  closed: ['offer', 'rejected', 'abandoned', 'filtered', 'expired'] as Stage[],
};

/** Une candidature est considérée comme partie dès ces statuts : on ne repostule jamais. */
export const SUBMITTED_STAGES: Stage[] = [
  'sent',
  'confirmed',
  'interview_hr',
  'interview_tech',
  'offer',
  'rejected',
  'no_response',
  'follow_up_needed',
];

export function isSubmitted(stage: Stage): boolean {
  return SUBMITTED_STAGES.includes(stage);
}

// Transitions autorisées. Tout ce qui n'est pas listé est refusé : une opération
// interrompue ou rejouée ne peut pas faire reculer une candidature déjà envoyée.
const T: Record<Stage, Stage[]> = {
  new: ['to_analyze', 'filtered', 'expired', 'abandoned', 'awaiting_feedback'],
  to_analyze: ['analyzed', 'awaiting_feedback', 'filtered', 'expired', 'abandoned'],
  analyzed: ['awaiting_feedback', 'to_analyze', 'cv_in_progress', 'expired', 'abandoned', 'filtered'],
  awaiting_feedback: ['cv_in_progress', 'to_analyze', 'abandoned', 'expired', 'analyzed'],
  cv_in_progress: ['letter_in_progress', 'ready_to_apply', 'awaiting_feedback', 'abandoned', 'expired'],
  letter_in_progress: ['ready_to_apply', 'cv_in_progress', 'awaiting_feedback', 'abandoned', 'expired'],
  ready_to_apply: ['applying', 'sent', 'cv_in_progress', 'letter_in_progress', 'abandoned', 'expired'],
  applying: ['sent', 'ready_to_apply', 'abandoned'],
  sent: ['confirmed', 'interview_hr', 'interview_tech', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'abandoned'],
  confirmed: ['interview_hr', 'interview_tech', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'abandoned'],
  follow_up_needed: ['sent', 'confirmed', 'interview_hr', 'interview_tech', 'offer', 'rejected', 'no_response', 'abandoned'],
  no_response: ['interview_hr', 'interview_tech', 'offer', 'rejected', 'follow_up_needed', 'abandoned'],
  interview_hr: ['interview_tech', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'abandoned'],
  interview_tech: ['interview_hr', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'abandoned'],
  offer: ['rejected', 'abandoned'],
  rejected: ['interview_hr', 'interview_tech', 'offer'],
  abandoned: ['to_analyze', 'awaiting_feedback'],
  filtered: ['to_analyze', 'awaiting_feedback', 'expired'],
  expired: ['to_analyze'],
};

export function canTransition(from: Stage, to: Stage): boolean {
  if (from === to) return true;
  return T[from]?.includes(to) ?? false;
}

// Seuils de décision de l'analyse ATS (note sur 20). Valeurs par défaut reprises
// de la méthode de notation de l'utilisateur ; modifiables dans les paramètres.
export const DEFAULT_ATS_THRESHOLDS = { excellent: 15, interesting: 13, limited: 11 };

export type AtsDecision = 'excellent' | 'interesting' | 'limited' | 'weak';

export const ATS_DECISION_LABELS: Record<AtsDecision, string> = {
  excellent: 'Excellente adéquation',
  interesting: 'Candidature intéressante',
  limited: 'Adéquation limitée',
  weak: 'Faible adéquation',
};

export function atsDecision(
  score20: number,
  t: { excellent: number; interesting: number; limited: number } = DEFAULT_ATS_THRESHOLDS,
): AtsDecision {
  if (score20 >= t.excellent) return 'excellent';
  if (score20 >= t.interesting) return 'interesting';
  if (score20 >= t.limited) return 'limited';
  return 'weak';
}
