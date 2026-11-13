// Plateformes de candidature : détection et politique d'automatisation.
//
// Chaque plateforme est décrite avec ce qui est permis, ce qui ne l'est pas, et la
// preuve (texte des conditions ou documentation officielle, avec sa date de
// vérification). La politique fixe le plafond d'automatisation : l'utilisateur peut
// automatiser moins, jamais plus. Rien n'est contourné : une interdiction, un CAPTCHA
// ou une protection anti-robots conduisent à la meilleure alternative autorisée.

export type PlatformId =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workday'
  | 'workable'
  | 'recruitee'
  | 'personio'
  | 'teamtailor'
  | 'icims'
  | 'taleo'
  | 'successfactors'
  | 'breezy'
  | 'jobvite'
  | 'bamboohr'
  | 'linkedin'
  | 'indeed'
  | 'wttj'
  | 'apec'
  | 'francetravail'
  | 'hellowork'
  | 'glassdoor'
  | 'jobteaser'
  | 'efinancialcareers'
  | 'vie'
  | 'email'
  | 'generic';

/**
 * Plafond d'automatisation :
 *  - auto : remplissage et envoi automatiques possibles (si l'utilisateur l'autorise) ;
 *  - prefill : remplissage automatique, envoi par l'utilisateur ;
 *  - manual : aucune automatisation sur la plateforme ; JobAgent prépare tout (documents, réponses à copier).
 */
export type Autonomy = 'auto' | 'prefill' | 'manual';
export type Verdict = 'allowed' | 'not_prohibited' | 'restricted' | 'prohibited' | 'unverified';

export interface Evidence {
  url: string;
  quote: string;
  checkedAt: string;
}

export interface PlatformPolicy {
  id: PlatformId;
  name: string;
  /** Lecture automatique des offres (API publique, flux, page publique). */
  read: { verdict: Verdict; method: string };
  /** Alertes e-mail utilisables (lues dans la boîte de l'utilisateur, avec son accord). */
  emailAlerts: boolean;
  /** API officielle de candidature utilisable par un candidat. */
  officialApply: { available: boolean; note: string };
  /** Automatisation du navigateur pour remplir le formulaire. */
  browserAutomation: Verdict;
  /** Envoi automatique de la candidature. */
  autoSubmit: Verdict;
  /** Plafond retenu par JobAgent. */
  autonomy: Autonomy;
  /** Interventions humaines prévisibles. */
  human: string[];
  limits: string[];
  evidence: Evidence[];
}

const CHECKED = '2026-11-13';

export const PLATFORM_POLICIES: Record<PlatformId, PlatformPolicy> = {
  greenhouse: {
    id: 'greenhouse',
    name: 'Greenhouse',
    read: { verdict: 'allowed', method: 'API publique Job Board (GET boards-api.greenhouse.io), sans authentification' },
    emailAlerts: false,
    officialApply: { available: false, note: "La soumission par API (POST Job Board) exige la clé d'API de l'employeur : réservée aux sites carrière des entreprises." },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'not_prohibited',
    autonomy: 'auto',
    human: ['CAPTCHA éventuel au moment de l’envoi', 'questions propres à l’employeur jamais rencontrées'],
    limits: ["MyGreenhouse (compte candidat) interdit les moyens automatisés : JobAgent ne l'utilise pas et passe par le formulaire public de l'employeur."],
    evidence: [
      { url: 'https://docs.greenhouse.io/job-board.html', quote: '(POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}) requires Basic Auth. The Job Board API Key must be Base64 encoded before it can be used to post applications.', checkedAt: CHECKED },
      { url: 'https://my.greenhouse.io/users/agreement', quote: 'You agree that you will not … (z) use automated means, including spiders, robots, crawlers, or similar means or processes to access or use the Services.', checkedAt: CHECKED },
    ],
  },
  lever: {
    id: 'lever',
    name: 'Lever',
    read: { verdict: 'allowed', method: 'API publique Postings (GET api.lever.co/v0/postings/{site})' },
    emailAlerts: false,
    officialApply: { available: false, note: "L'envoi par API (POST /postings/:id/apply) exige une clé générée par un administrateur de l'employeur." },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'not_prohibited',
    autonomy: 'auto',
    human: ['CAPTCHA (hCaptcha) souvent présent à l’envoi : transmis à l’utilisateur, jamais contourné'],
    limits: [],
    evidence: [
      { url: 'https://github.com/lever/postings-api', quote: 'To use the POST API, you need an API key, which a Super Admin of your account can generate from your integrations settings page.', checkedAt: CHECKED },
    ],
  },
  ashby: {
    id: 'ashby',
    name: 'Ashby',
    read: { verdict: 'allowed', method: 'API publique posting-api (GET api.ashbyhq.com/posting-api/job-board/{org})' },
    emailAlerts: false,
    officialApply: { available: false, note: "applicationForm.submit est destiné aux sites carrière des employeurs et s'authentifie avec leur clé d'API." },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'not_prohibited',
    autonomy: 'auto',
    human: ['CAPTCHA éventuel'],
    limits: [],
    evidence: [
      { url: 'https://developers.ashbyhq.com/docs/creating-a-custom-careers-page', quote: 'Submit the core application form … POST https://api.ashbyhq.com/applicationForm.submit (guide destiné aux employeurs qui construisent leur propre page carrière).', checkedAt: CHECKED },
      { url: 'https://developers.ashbyhq.com/reference/authentication', quote: 'curl https://api.ashbyhq.com/application.list -u API_KEY: …', checkedAt: CHECKED },
    ],
  },
  smartrecruiters: {
    id: 'smartrecruiters',
    name: 'SmartRecruiters',
    read: { verdict: 'allowed', method: 'API publique Posting (GET api.smartrecruiters.com/v1/companies/{id}/postings)' },
    emailAlerts: false,
    officialApply: { available: false, note: "L'Application API est réservée aux clients et partenaires de SmartRecruiters." },
    browserAutomation: 'restricted',
    autoSubmit: 'restricted',
    autonomy: 'prefill',
    human: ['envoi par l’utilisateur', 'contrôle anti-robots (DataDome) possible'],
    limits: ["Protection anti-robots dédiée aux candidatures automatisées : JobAgent remplit le formulaire dans votre navigateur (extension) et vous laisse l'envoyer, sans chercher à passer ce contrôle."],
    evidence: [
      { url: 'https://developers.smartrecruiters.com/docs/application-api-1', quote: 'The Application API enables our customers and partners to integrate the SmartRecruiters application process into their own career site or job board.', checkedAt: CHECKED },
      { url: 'https://datadome.co/customers-stories/smartrecruiters-crushes-spam-job-applications-without-disrupting-real-users/', quote: 'SmartRecruiters enjoys stronger bot protection, and can ensure applications are from genuine job seekers, not bots or automated scripts.', checkedAt: CHECKED },
      { url: 'https://www.smartrecruiters.com/legal/terms-of-use/', quote: 'Use automatic means to access content or data from other users; (Candidate Terms of Use, last modified on 14th May 2019)', checkedAt: CHECKED },
    ],
  },
  workday: {
    id: 'workday',
    name: 'Workday',
    read: { verdict: 'not_prohibited', method: 'Pages carrière publiques de chaque employeur (lecture espacée)' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API de candidature ouverte aux candidats.' },
    browserAutomation: 'restricted',
    autoSubmit: 'restricted',
    autonomy: 'prefill',
    human: ['création ou connexion au compte candidat de l’employeur (mot de passe saisi par vous, jamais stocké en clair)', 'vérification de l’adresse e-mail', 'envoi final'],
    limits: ['Un compte par employeur, protégé par mot de passe : le formulaire en plusieurs étapes est rempli dans votre navigateur par l’extension, à partir de vos réponses enregistrées.'],
    evidence: [{ url: 'https://www.workday.com/en-us/privacy/recruiting-privacy-statement.html', quote: 'When you visit the Workday Recruitment site, we use cookies, tracking pixels, and scripts. (Chaque employeur exploite son propre site, avec compte candidat.)', checkedAt: CHECKED }],
  },
  workable: {
    id: 'workable',
    name: 'Workable',
    read: { verdict: 'allowed', method: 'Widget public des offres (apply.workable.com)' },
    emailAlerts: false,
    officialApply: { available: false, note: "L'API de Workable est réservée aux comptes employeurs." },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'not_prohibited',
    autonomy: 'auto',
    human: ['CAPTCHA en cas de trafic jugé suspect'],
    limits: ['Workable signale aux recruteurs les candidatures « AI-assisted » : votre candidature peut porter cette mention. JobAgent utilise toujours votre véritable adresse e-mail.'],
    evidence: [
      { url: 'https://help.workable.com/hc/en-us/articles/35293126257815-Managing-AI-assisted-and-automated-job-applications', quote: 'Once a candidate applies to a Workable job that triggers the blacklist attributes … The candidate is tagged as AI-assisted. … Rate limiting, bot management, and CAPTCHA for suspicious traffic.', checkedAt: CHECKED },
    ],
  },
  recruitee: {
    id: 'recruitee',
    name: 'Recruitee',
    read: { verdict: 'allowed', method: 'API publique des pages carrière ({entreprise}.recruitee.com/api/offers)' },
    emailAlerts: false,
    officialApply: { available: false, note: 'Aucune API de candidature ouverte aux candidats.' },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'not_prohibited',
    autonomy: 'auto',
    human: [],
    limits: [],
    evidence: [],
  },
  personio: {
    id: 'personio',
    name: 'Personio',
    read: { verdict: 'allowed', method: 'Flux XML public des offres ({entreprise}.jobs.personio.de/xml)' },
    emailAlerts: false,
    officialApply: { available: false, note: "L'API de candidature de Personio exige un jeton de l'employeur." },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'not_prohibited',
    autonomy: 'auto',
    human: [],
    limits: [],
    evidence: [],
  },
  teamtailor: {
    id: 'teamtailor',
    name: 'Teamtailor',
    read: { verdict: 'not_prohibited', method: 'Pages carrière publiques' },
    emailAlerts: false,
    officialApply: { available: false, note: 'Aucune API de candidature ouverte aux candidats.' },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'not_prohibited',
    autonomy: 'auto',
    human: ['confirmation de l’adresse e-mail demandée par certains employeurs'],
    limits: [],
    evidence: [],
  },
  icims: {
    id: 'icims',
    name: 'iCIMS',
    read: { verdict: 'not_prohibited', method: 'Pages carrière publiques' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API de candidature ouverte aux candidats.' },
    browserAutomation: 'restricted',
    autoSubmit: 'restricted',
    autonomy: 'prefill',
    human: ['compte candidat de l’employeur', 'envoi final'],
    limits: ['Formulaires dans des cadres imbriqués et compte candidat : remplissage dans votre navigateur.'],
    evidence: [],
  },
  taleo: {
    id: 'taleo',
    name: 'Oracle Taleo',
    read: { verdict: 'not_prohibited', method: 'Pages carrière publiques' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API de candidature ouverte aux candidats.' },
    browserAutomation: 'restricted',
    autoSubmit: 'restricted',
    autonomy: 'prefill',
    human: ['compte candidat de l’employeur', 'envoi final'],
    limits: ['Compte obligatoire et parcours en plusieurs étapes.'],
    evidence: [],
  },
  successfactors: {
    id: 'successfactors',
    name: 'SAP SuccessFactors',
    read: { verdict: 'not_prohibited', method: 'Pages carrière publiques' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API de candidature ouverte aux candidats.' },
    browserAutomation: 'restricted',
    autoSubmit: 'restricted',
    autonomy: 'prefill',
    human: ['compte candidat de l’employeur', 'envoi final'],
    limits: ['Compte obligatoire.'],
    evidence: [],
  },
  breezy: {
    id: 'breezy',
    name: 'Breezy HR',
    read: { verdict: 'allowed', method: 'Flux JSON public ({entreprise}.breezy.hr/json)' },
    emailAlerts: false,
    officialApply: { available: false, note: 'Aucune API de candidature ouverte aux candidats.' },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'not_prohibited',
    autonomy: 'auto',
    human: [],
    limits: [],
    evidence: [],
  },
  jobvite: {
    id: 'jobvite',
    name: 'Jobvite',
    read: { verdict: 'not_prohibited', method: 'Pages carrière publiques' },
    emailAlerts: false,
    officialApply: { available: false, note: 'Aucune API de candidature ouverte aux candidats.' },
    browserAutomation: 'unverified',
    autoSubmit: 'unverified',
    autonomy: 'prefill',
    human: ['envoi final'],
    limits: ["Conditions non vérifiées : envoi laissé à l'utilisateur."],
    evidence: [],
  },
  bamboohr: {
    id: 'bamboohr',
    name: 'BambooHR',
    read: { verdict: 'not_prohibited', method: 'Pages carrière publiques ({entreprise}.bamboohr.com/careers)' },
    emailAlerts: false,
    officialApply: { available: false, note: 'Aucune API de candidature ouverte aux candidats.' },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'unverified',
    autonomy: 'prefill',
    human: ['envoi final'],
    limits: ["Conditions non vérifiées : envoi laissé à l'utilisateur."],
    evidence: [],
  },
  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    read: { verdict: 'prohibited', method: 'Aucune lecture automatisée : alertes e-mail de LinkedIn lues dans votre boîte, import de vos exports' },
    emailAlerts: true,
    officialApply: { available: false, note: "Aucune API de candidature pour les candidats." },
    browserAutomation: 'prohibited',
    autoSubmit: 'prohibited',
    autonomy: 'manual',
    human: ['candidature « Easy Apply » faite par vous, avec les réponses et documents préparés'],
    limits: ["Les offres LinkedIn qui renvoient vers le site de l'employeur sont traitées sur ce site (Greenhouse, Workday…), selon sa propre politique."],
    evidence: [{ url: 'https://www.linkedin.com/legal/user-agreement', quote: 'Use bots or other automated methods to access the Services, add or download contacts, send or redirect messages;', checkedAt: CHECKED }],
  },
  indeed: {
    id: 'indeed',
    name: 'Indeed',
    read: { verdict: 'restricted', method: 'Alertes e-mail d’Indeed lues dans votre boîte' },
    emailAlerts: true,
    officialApply: { available: false, note: "Indeed Apply n'est ouvert qu'aux partenaires agréés." },
    browserAutomation: 'prohibited',
    autoSubmit: 'prohibited',
    autonomy: 'manual',
    human: ['candidature Indeed Apply faite par vous'],
    limits: ["Les offres Indeed qui renvoient vers le site de l'employeur sont traitées sur ce site."],
    evidence: [
      { url: 'https://www.indeed.com/legal', quote: 'Use of any automation, scripting, or bots to automate the Indeed Apply process outside of Indeed’s official vendors and tooling is prohibited.', checkedAt: CHECKED },
      { url: 'https://www.indeed.com/legal', quote: 'Submit job applications or other User Content by automated means, in bulk or otherwise, other than by automated tools that the Site explicitly offers or that have been otherwise agreed to in writing with Indeed;', checkedAt: CHECKED },
    ],
  },
  wttj: {
    id: 'wttj',
    name: 'Welcome to the Jungle',
    read: { verdict: 'prohibited', method: 'Alertes e-mail de WTTJ lues dans votre boîte ; lien de chaque offre conservé' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API de candidature pour les candidats.' },
    browserAutomation: 'prohibited',
    autoSubmit: 'prohibited',
    autonomy: 'manual',
    human: ['candidature sur le formulaire WTTJ faite par vous'],
    limits: ["Beaucoup d'offres WTTJ renvoient vers l'ATS de l'employeur : elles y sont traitées selon la politique de cet ATS."],
    evidence: [
      { url: 'https://www.welcometothejungle.com/fr/pages/terms', quote: 'Développer, soutenir ou utiliser tout logiciel, dispositif, script, robot ou tout autre moyen ou procédé (y compris, sans s’y limiter, les robots d’indexation, les extensions et modules de navigateur, ou toute autre technologie) pour procéder à une extraction automatisée de données (« scraping ») … (CGU du 27 avril 2026)', checkedAt: CHECKED },
    ],
  },
  apec: {
    id: 'apec',
    name: 'Apec',
    read: { verdict: 'unverified', method: 'Alertes e-mail de l’Apec lues dans votre boîte' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API publique.' },
    browserAutomation: 'unverified',
    autoSubmit: 'unverified',
    autonomy: 'manual',
    human: ['candidature sur le site de l’Apec faite par vous (compte)'],
    limits: ['Conditions non vérifiées : aucune automatisation tant que ce n’est pas établi.'],
    evidence: [],
  },
  francetravail: {
    id: 'francetravail',
    name: 'France Travail',
    read: { verdict: 'restricted', method: "API officielle « Offres d'emploi » temporairement retirée ; alertes e-mail" },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API de candidature pour les candidats.' },
    browserAutomation: 'unverified',
    autoSubmit: 'unverified',
    autonomy: 'manual',
    human: ['candidature sur le site de France Travail faite par vous'],
    limits: [],
    evidence: [{ url: 'https://www.data.gouv.fr/dataservices/api-offres-demploi', quote: "L'API Offre d'emploi de France Travail n'est actuellement plus exposée sur www.francetravail.io le temps d'une analyse des modalités de distribution et de réutilisation du service.", checkedAt: CHECKED }],
  },
  hellowork: {
    id: 'hellowork',
    name: 'HelloWork',
    read: { verdict: 'unverified', method: 'Alertes e-mail lues dans votre boîte' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API publique.' },
    browserAutomation: 'unverified',
    autoSubmit: 'unverified',
    autonomy: 'manual',
    human: ['candidature faite par vous'],
    limits: ['Conditions non vérifiées.'],
    evidence: [],
  },
  glassdoor: {
    id: 'glassdoor',
    name: 'Glassdoor',
    read: { verdict: 'unverified', method: 'Alertes e-mail lues dans votre boîte' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API publique.' },
    browserAutomation: 'unverified',
    autoSubmit: 'unverified',
    autonomy: 'manual',
    human: ['candidature faite par vous'],
    limits: ['Conditions non vérifiées.'],
    evidence: [],
  },
  jobteaser: {
    id: 'jobteaser',
    name: 'JobTeaser',
    read: { verdict: 'unverified', method: 'Alertes e-mail de votre école lues dans votre boîte' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API publique.' },
    browserAutomation: 'unverified',
    autoSubmit: 'unverified',
    autonomy: 'manual',
    human: ['candidature faite par vous'],
    limits: ['Accès lié à votre établissement.'],
    evidence: [],
  },
  efinancialcareers: {
    id: 'efinancialcareers',
    name: 'eFinancialCareers',
    read: { verdict: 'unverified', method: 'Alertes e-mail lues dans votre boîte' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API publique.' },
    browserAutomation: 'unverified',
    autoSubmit: 'unverified',
    autonomy: 'manual',
    human: ['candidature faite par vous'],
    limits: ['Conditions non vérifiées.'],
    evidence: [],
  },
  vie: {
    id: 'vie',
    name: 'Mon Volontariat International (VIE/VIA)',
    read: { verdict: 'unverified', method: 'Alertes e-mail de votre espace candidat ; pages publiques des offres' },
    emailAlerts: true,
    officialApply: { available: false, note: 'Aucune API publique documentée.' },
    browserAutomation: 'unverified',
    autoSubmit: 'unverified',
    autonomy: 'manual',
    human: ['candidature depuis votre espace Mon Volontariat'],
    limits: ['Candidature rattachée à votre dossier Business France.'],
    evidence: [],
  },
  email: {
    id: 'email',
    name: 'Candidature par e-mail',
    read: { verdict: 'allowed', method: 'Adresse indiquée dans l’annonce' },
    emailAlerts: false,
    officialApply: { available: false, note: '—' },
    browserAutomation: 'allowed',
    autoSubmit: 'restricted',
    autonomy: 'prefill',
    human: ["envoi de l'e-mail préparé (sauf autorisation d'envoi donnée dans les paramètres)"],
    limits: ["Par défaut, l'e-mail est préparé en brouillon, jamais envoyé sans votre autorisation."],
    evidence: [],
  },
  generic: {
    id: 'generic',
    name: "Site carrière de l'entreprise",
    read: { verdict: 'not_prohibited', method: 'Page publique de l’offre (lecture espacée)' },
    emailAlerts: false,
    officialApply: { available: false, note: '—' },
    browserAutomation: 'not_prohibited',
    autoSubmit: 'unverified',
    autonomy: 'prefill',
    human: ['envoi final, sauf autorisation explicite pour les sites carrière'],
    limits: ["Conditions propres à chaque site : l'envoi automatique n'est fait que si vous l'autorisez pour les sites carrière."],
    evidence: [],
  },
};

const HOST_RULES: { id: PlatformId; test: (host: string, path: string) => boolean }[] = [
  { id: 'greenhouse', test: (h) => /(^|\.)greenhouse\.io$/.test(h) },
  { id: 'lever', test: (h) => /(^|\.)lever\.co$/.test(h) },
  { id: 'ashby', test: (h) => /(^|\.)ashbyhq\.com$/.test(h) },
  { id: 'smartrecruiters', test: (h) => /(^|\.)smartrecruiters\.com$/.test(h) },
  { id: 'workday', test: (h) => /myworkdayjobs\.com$|myworkdaysite\.com$|(^|\.)workday\.com$/.test(h) },
  { id: 'workable', test: (h) => /(^|\.)workable\.com$/.test(h) },
  { id: 'recruitee', test: (h) => /(^|\.)recruitee\.com$/.test(h) },
  { id: 'personio', test: (h) => /jobs\.personio\.(de|com)$/.test(h) },
  { id: 'teamtailor', test: (h) => /(^|\.)teamtailor\.com$/.test(h) },
  { id: 'icims', test: (h) => /(^|\.)icims\.com$/.test(h) },
  { id: 'taleo', test: (h) => /(^|\.)taleo\.net$/.test(h) },
  { id: 'successfactors', test: (h) => /successfactors\.(com|eu)$|(^|\.)sapsf\.(com|eu)$|^jobs\.sap\.com$/.test(h) },
  { id: 'breezy', test: (h) => /(^|\.)breezy\.hr$/.test(h) },
  { id: 'jobvite', test: (h) => /(^|\.)jobvite\.com$/.test(h) },
  { id: 'bamboohr', test: (h) => /(^|\.)bamboohr\.com$/.test(h) },
  { id: 'linkedin', test: (h) => /(^|\.)linkedin\.com$/.test(h) },
  { id: 'indeed', test: (h) => /(^|\.)indeed\.(com|fr|co\.uk|de|es|it|be|ch|lu|nl|ca)$/.test(h) },
  { id: 'wttj', test: (h) => /(^|\.)welcometothejungle\.com$/.test(h) },
  { id: 'apec', test: (h) => /(^|\.)apec\.fr$/.test(h) },
  { id: 'francetravail', test: (h) => /(^|\.)(francetravail|pole-emploi)\.fr$/.test(h) },
  { id: 'hellowork', test: (h) => /(^|\.)hellowork\.com$/.test(h) },
  { id: 'glassdoor', test: (h) => /(^|\.)glassdoor\.[a-z.]+$/.test(h) },
  { id: 'jobteaser', test: (h) => /(^|\.)jobteaser\.com$/.test(h) },
  { id: 'efinancialcareers', test: (h) => /(^|\.)efinancialcareers\.[a-z.]+$/.test(h) },
  { id: 'vie', test: (h) => /mon-vie-via\.businessfrance\.fr$|(^|\.)civiweb\.com$/.test(h) },
];

/** Plateforme d'une adresse de candidature (ou d'un contenu HTML, pour les ATS intégrés à un site carrière). */
export function detectPlatform(url: string, html = ''): PlatformId {
  if (/^mailto:/i.test(url)) return 'email';
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const r of HOST_RULES) if (r.test(host, u.pathname)) return r.id;
    // Greenhouse intégré dans un site carrière (gh_jid) ou formulaire embarqué.
    if (u.searchParams.has('gh_jid') || /boards\.greenhouse\.io\/embed|grnhse_app/.test(html)) return 'greenhouse';
    if (/jobs\.lever\.co\//.test(html)) return 'lever';
    if (/jobs\.ashbyhq\.com|ashby_embed/.test(html)) return 'ashby';
    if (/myworkdayjobs\.com/.test(html)) return 'workday';
    if (/smartrecruiters\.com\/oneclick|jobs\.smartrecruiters\.com/.test(html)) return 'smartrecruiters';
  } catch {
    /* adresse invalide : traitée comme site générique */
  }
  return 'generic';
}

export function policyFor(id: PlatformId): PlatformPolicy {
  return PLATFORM_POLICIES[id];
}

/** Plafond effectif : le plus restrictif entre la politique de la plateforme et le choix de l'utilisateur. */
export function effectiveAutonomy(id: PlatformId, userChoice: Partial<Record<PlatformId, Autonomy>> = {}): Autonomy {
  const rank: Record<Autonomy, number> = { manual: 0, prefill: 1, auto: 2 };
  const cap = PLATFORM_POLICIES[id].autonomy;
  const wanted = userChoice[id];
  if (!wanted) return cap;
  return rank[wanted] < rank[cap] ? wanted : cap;
}
