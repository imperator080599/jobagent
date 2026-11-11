// Catalogue du référentiel personnel : les informations dont une candidature peut
// avoir besoin. Chaque information validée est réutilisée partout et n'est jamais
// redemandée. Une information absente n'est jamais devinée : elle est demandée.

export type FactType = 'text' | 'longtext' | 'boolean' | 'choice' | 'list' | 'date' | 'salary_list';

export interface FactDef {
  key: string;
  category: FactCategoryId;
  label: string;
  type: FactType;
  options?: string[];
  hint?: string;
  /** Donnée sensible : jamais transmise dans un formulaire sans validation explicite. */
  sensitive?: boolean;
  /** Fréquemment exigée dans les formulaires : à renseigner en priorité. */
  important?: boolean;
  /** Alimentée automatiquement depuis le CV master (reste modifiable). */
  fromCv?: boolean;
}

export const FACT_CATEGORIES = [
  { id: 'contact', label: 'Coordonnées', description: 'Reprises telles quelles dans les formulaires et les documents.' },
  { id: 'eligibility', label: 'Nationalité et droit au travail', description: 'Questions juridiques : uniquement vos déclarations, jamais de supposition.' },
  { id: 'mobility', label: 'Mobilité et disponibilité', description: '' },
  { id: 'compensation', label: 'Rémunération', description: 'Par pays et par devise. Jamais communiquée sans que vous l\'ayez renseignée.' },
  { id: 'preferences', label: 'Préférences', description: '' },
  { id: 'background', label: 'Parcours', description: 'Synthèse issue de votre CV master.' },
  { id: 'motivations', label: 'Motivations', description: 'Utilisées pour rédiger des lettres réellement personnelles. Rien n\'est inventé à votre place.' },
  { id: 'writing', label: 'Préférences de rédaction', description: 'Règles de style appliquées aux CV et aux lettres.' },
  { id: 'skills', label: 'Compétences précisées', description: 'Compétences confirmées ou infirmées en réponse aux questions de l\'agent.' },
  { id: 'other', label: 'Autres informations', description: '' },
] as const;
export type FactCategoryId = (typeof FACT_CATEGORIES)[number]['id'];

export const FACT_CATALOG: FactDef[] = [
  { key: 'contact.first_name', category: 'contact', label: 'Prénom', type: 'text', important: true, fromCv: true },
  { key: 'contact.last_name', category: 'contact', label: 'Nom', type: 'text', important: true, fromCv: true },
  { key: 'contact.email', category: 'contact', label: 'Email de candidature', type: 'text', important: true, fromCv: true },
  { key: 'contact.phone', category: 'contact', label: 'Téléphone', type: 'text', hint: 'Format international, ex. +33 6 12 34 56 78', important: true, fromCv: true },
  { key: 'contact.address', category: 'contact', label: 'Adresse postale', type: 'text' },
  { key: 'contact.postal_code', category: 'contact', label: 'Code postal', type: 'text' },
  { key: 'contact.city', category: 'contact', label: 'Ville de résidence', type: 'text', important: true },
  { key: 'contact.country', category: 'contact', label: 'Pays de résidence', type: 'text', important: true },
  { key: 'contact.linkedin_url', category: 'contact', label: 'Profil LinkedIn', type: 'text', fromCv: true },
  { key: 'contact.website', category: 'contact', label: 'Site ou portfolio', type: 'text' },

  { key: 'eligibility.nationalities', category: 'eligibility', label: 'Nationalité(s)', type: 'list', sensitive: true, important: true },
  { key: 'eligibility.work_authorization', category: 'eligibility', label: 'Pays où vous êtes autorisé à travailler sans démarche', type: 'list', hint: 'Ex. France, Union européenne, Suisse…', important: true },
  { key: 'eligibility.sponsorship_needed', category: 'eligibility', label: 'Pays où un visa ou un sponsoring serait nécessaire', type: 'list', important: true },
  { key: 'eligibility.vie_eligible', category: 'eligibility', label: 'Éligible au V.I.E (18-28 ans, nationalité de l\'EEE)', type: 'boolean' },
  { key: 'eligibility.date_of_birth', category: 'eligibility', label: 'Date de naissance', type: 'date', sensitive: true },
  { key: 'eligibility.driving_license', category: 'eligibility', label: 'Permis de conduire', type: 'text' },

  { key: 'mobility.relocation', category: 'mobility', label: 'Prêt à déménager pour un poste', type: 'boolean', important: true },
  { key: 'mobility.countries', category: 'mobility', label: 'Pays ou villes envisagés', type: 'list' },
  { key: 'mobility.travel', category: 'mobility', label: 'Déplacements professionnels acceptés', type: 'text', hint: 'Ex. jusqu\'à 30 % du temps' },
  { key: 'availability.notice_period', category: 'mobility', label: 'Préavis', type: 'text', hint: 'Ex. 3 mois, négociable', important: true },
  { key: 'availability.start_date', category: 'mobility', label: 'Date de disponibilité', type: 'text', hint: 'Date ou formulation, ex. « à partir de mars 2027 »', important: true },

  { key: 'compensation.expectations', category: 'compensation', label: 'Prétentions salariales', type: 'salary_list', sensitive: true, important: true },
  { key: 'compensation.current', category: 'compensation', label: 'Rémunération actuelle', type: 'text', sensitive: true, hint: 'Facultatif. Communiquée uniquement si un formulaire l\'exige et que vous l\'avez autorisé.' },

  { key: 'preferences.contracts', category: 'preferences', label: 'Types de contrat acceptés', type: 'list', hint: 'CDI, V.I.E, CDD…' },
  { key: 'preferences.remote', category: 'preferences', label: 'Télétravail', type: 'choice', options: ['Indifférent', 'Sur site', 'Hybride', 'Télétravail complet'] },
  { key: 'preferences.how_heard', category: 'preferences', label: 'Réponse par défaut à « Comment avez-vous connu cette offre ? »', type: 'text', hint: 'Ex. « Site carrières de l\'entreprise »' },

  { key: 'background.current_title', category: 'background', label: 'Poste actuel', type: 'text', fromCv: true },
  { key: 'background.current_employer', category: 'background', label: 'Employeur actuel', type: 'text', fromCv: true },
  { key: 'background.years_experience', category: 'background', label: "Années d'expérience professionnelle", type: 'text', hint: 'Hors stages, sauf indication contraire', important: true },
  { key: 'background.highest_degree', category: 'background', label: 'Diplôme le plus élevé', type: 'text', fromCv: true },
  { key: 'background.school', category: 'background', label: 'École ou université', type: 'text', fromCv: true },
  { key: 'background.graduation_year', category: 'background', label: "Année d'obtention du diplôme", type: 'text', fromCv: true },
  { key: 'background.languages', category: 'background', label: 'Langues et niveaux', type: 'list', fromCv: true },

  { key: 'motivations.career_goal', category: 'motivations', label: 'Votre objectif professionnel', type: 'longtext', hint: 'Le poste et la trajectoire que vous visez, en quelques phrases.' },
  { key: 'motivations.why_field', category: 'motivations', label: 'Pourquoi ce métier ?', type: 'longtext', hint: 'Ce qui vous attire réellement, avec vos mots.' },
  { key: 'motivations.transition', category: 'motivations', label: 'Comment expliquez-vous votre évolution ?', type: 'longtext', hint: 'Le fil conducteur entre votre parcours et le poste visé.' },
  { key: 'motivations.strengths', category: 'motivations', label: 'Vos atouts distinctifs', type: 'longtext', hint: 'Deux ou trois points forts, illustrés si possible.' },

  { key: 'writing.rules', category: 'writing', label: 'Règles de rédaction', type: 'list', hint: 'Ex. « pas de superlatifs », « vouvoiement », « phrases courtes »' },
  { key: 'writing.signature', category: 'writing', label: 'Signature des lettres', type: 'text', hint: 'Ex. Prénom Nom' },
];

export const FACT_BY_KEY = new Map(FACT_CATALOG.map((f) => [f.key, f]));

export interface SalaryExpectation {
  country: string;
  currency: string;
  min: number | null;
  max: number | null;
  period: 'year' | 'month';
  note?: string;
}

/** Clé de fait pour une compétence précisée par l'utilisateur. */
export function skillFactKey(skill: string): string {
  return `skill:${skill
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim()}`;
}

export interface SkillFact {
  name: string;
  /** true = compétence détenue ; false = non maîtrisée (ne jamais la revendiquer). */
  has: boolean;
  level?: string;
  /** Précision de l'utilisateur : contexte réel d'utilisation. */
  context?: string;
}
