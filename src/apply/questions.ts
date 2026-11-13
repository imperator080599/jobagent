// Questions des formulaires de candidature : reconnaissance et réponses.
//
// Chaque champ est rattaché, si possible, à une question canonique (prénom, droit au
// travail, prétentions…) reconnue en français, anglais, espagnol et allemand, quelle
// que soit sa formulation. La réponse vient toujours d'une source identifiée :
// information validée du profil, réponse déjà donnée par l'utilisateur, document
// validé, ou déduction factuelle (ex. la source réelle de l'offre). Une information
// inconnue n'est jamais inventée : la question est posée une fois, puis réutilisée.
import { normalize } from '../core/text.js';

export interface FormOption {
  value: string;
  label: string;
}

/** Champ tel que lu sur la page (voir engine/inpage.js). */
export interface FormField {
  key: string;
  tag: 'input' | 'select' | 'textarea' | 'combobox';
  type: string;
  label: string;
  name: string;
  id: string;
  required: boolean;
  options: FormOption[];
  multiple: boolean;
  accept: string;
  value: string;
  checked?: boolean;
  placeholder: string;
  autocomplete: string;
  section: string;
  maxLength?: number;
}

export type FileRole = 'resume' | 'cover_letter' | 'other';
export type ConsentKind = 'privacy' | 'accuracy' | 'marketing' | 'other';

export interface CanonicalQuestion {
  key: string;
  /** Libellés reconnus (texte normalisé : minuscules, sans accents). */
  patterns: RegExp[];
  /** Attributs techniques reconnus (name, id, autocomplete). */
  hints?: RegExp[];
  /** Le libellé à poser à l'utilisateur s'il faut lui demander. */
  ask: string;
  sensitive?: boolean;
  /** La réponse dépend du pays de l'offre (droit au travail, visa, salaire). */
  perCountry?: boolean;
}

const q = (key: string, ask: string, patterns: RegExp[], hints: RegExp[] = [], extra: Partial<CanonicalQuestion> = {}): CanonicalQuestion => ({ key, ask, patterns, hints, ...extra });

/**
 * Catalogue. L'ordre compte : les questions les plus spécifiques d'abord
 * (« nom de famille » avant « nom », « préavis » avant « disponibilité »).
 */
export const CANONICAL: CanonicalQuestion[] = [
  q('identity.first_name', 'Prénom', [/^(first|given) ?name\b/, /^prenom\b/, /^nombre\b(?! completo)/, /^vorname\b/, /\bprenom\b/], [/first.?name|given.?name|fname|prenom|vorname/i]),
  q('identity.last_name', 'Nom de famille', [/^(last|family|sur) ?name\b/, /^nom( de famille)?\b(?! complet)/, /^apellidos?\b/, /^(nachname|familienname)\b/], [/last.?name|family.?name|surname|lname|nachname/i]),
  q('identity.full_name', 'Nom complet', [/^(full |legal |your )?name\b/, /^nom complet\b/, /^nom et prenom|^prenom et nom/, /^nombre completo\b/, /^(vollstandiger )?name\b/], [/^name$|full.?name|_systemfield_name/i]),
  q('identity.preferred_name', 'Prénom d’usage', [/preferred (first )?name|nickname|prenom d.usage/], [/preferred/i]),
  q('identity.salutation', 'Civilité', [/^(civilite|salutation|anrede|title)\b/, /^tratamiento\b/], [/civilit|salutation|anrede/i]),
  q('identity.pronouns', 'Pronoms', [/\bpronouns?\b|\bpronoms?\b/]),
  q('contact.email', 'Adresse e-mail', [/e-?mail|courriel|correo/], [/e-?mail/i]),
  q('contact.phone', 'Téléphone', [/phone|telephone|mobile|portable|telefono|movil|handy|rufnummer/], [/phone|tel|mobile/i]),
  q('contact.phone_country', 'Indicatif téléphonique', [/(country|phone) code|indicatif|prefijo|landesvorwahl/]),
  q('contact.postal_code', 'Code postal', [/post(al)? ?code|zip|code postal|codigo postal|postleitzahl|\bplz\b/], [/zip|postal|postcode/i]),
  q('contact.address', 'Adresse postale', [/^(street )?address( line 1)?\b|^adresse( postale)?\b|^direccion\b|^(strasse|anschrift)\b/], [/address.?line.?1|street/i]),
  q('contact.city', 'Ville de résidence', [/^(current )?(city|town)\b|^ville\b|^ciudad\b|^(stadt|wohnort)\b|^(current )?location\b|^localisation\b|where are you (currently )?(based|located)|ou residez-vous|lieu de residence/], [/city|town|locality/i]),
  q('contact.country', 'Pays de résidence', [/^(country|pays|pais|land)( of residence| de residence)?\b|country of residence|pays de residence/], [/^country$|country.?of.?res/i]),
  q('links.linkedin', 'Profil LinkedIn', [/linkedin/], [/linkedin/i]),
  q('links.website', 'Site ou portfolio', [/website|portfolio|site (web|internet|personnel)|pagina web|webseite/], [/website|portfolio|urls\[other/i]),
  q('links.github', 'Profil GitHub', [/github/], [/github/i]),
  q('work.current_company', 'Employeur actuel', [/current (company|employer)|(entreprise|employeur) actuel|empresa actual|aktueller arbeitgeber/], [/^org$|current.?company/i]),
  q('work.current_title', 'Poste actuel', [/current (job )?title|current (position|role)|poste actuel|intitule de poste actuel|cargo actual|aktuelle position/]),
  q('work.years_experience', "Années d'expérience", [/years? (of )?(professional |relevant |work )?experience|how many years|annees d.experience|nombre d.annees|anos de experiencia|jahre (an )?berufserfahrung/]),
  q('education.school', 'École ou université', [/^(school|university|college|institution)\b|ecole|universite|etablissement|universidad|hochschule|universitat/], [/school|university/i]),
  q('education.degree', 'Diplôme', [/^(degree|diploma|highest (level of )?education|education level)\b|diplome|niveau d.etudes|titulacion|abschluss/], [/degree/i]),
  q('education.discipline', 'Spécialité', [/discipline|field of study|major|specialite|domaine d.etudes|especialidad|studienfach/]),
  q('education.graduation_year', "Année d'obtention du diplôme", [/graduation (year|date)|year of graduation|annee (d.obtention|de diplome)|ano de graduacion|abschlussjahr/]),
  q('eligibility.sponsorship', 'Besoin d’un visa ou d’un sponsoring', [/sponsor|visa|parrainage|patrocinio/], [], { perCountry: true }),
  q('eligibility.work_authorization', 'Autorisation de travailler', [/(legally )?(authori[sz]ed|eligible|entitled|right) to work|work (permit|authori[sz]ation)|autoris(e|ation) (a|de) travailler|permis de travail|droit de travailler|autorizacion para trabajar|arbeitserlaubnis|arbeitsgenehmigung/], [], { perCountry: true }),
  q('eligibility.nationality', 'Nationalité', [/nationalit|citizenship|staatsangehorigkeit|nacionalidad/], [], { sensitive: true }),
  q('eligibility.date_of_birth', 'Date de naissance', [/date of birth|birth ?date|date de naissance|fecha de nacimiento|geburtsdatum|\bdob\b/], [], { sensitive: true }),
  q('eligibility.driving_license', 'Permis de conduire', [/driv(ing|er.?s) licen[cs]e|permis de conduire|permiso de conducir|fuhrerschein/]),
  q('availability.notice_period', 'Préavis', [/notice period|preavis|periodo de preaviso|kundigungsfrist/]),
  q('availability.start_date', 'Date de disponibilité', [/start date|available (to start|from)|availability|when can you start|earliest start|date de disponibilite|disponibilite|disponible a partir|fecha de incorporacion|disponibilidad|eintrittsdatum|verfugbarkeit/]),
  q('compensation.expected', 'Prétentions salariales', [/(expected|desired|target) (salary|compensation|pay)|salary expectation|pretentions? salariales?|remuneration (souhaitee|attendue)|salaire (souhaite|attendu|envisage)|expectativas? salarial|gehaltsvorstellung|gehaltswunsch/], [], { sensitive: true, perCountry: true }),
  q('compensation.current', 'Rémunération actuelle', [/current (salary|compensation|pay)|remuneration actuelle|salaire actuel|salario actual|aktuelles gehalt/], [], { sensitive: true }),
  q('mobility.relocation', 'Prêt à déménager', [/relocat|demenag|mobilite geographique|reubicar|umzug/]),
  q('mobility.travel', 'Déplacements acceptés', [/willing to travel|travel requirement|deplacements?|disponibilidad para viajar|reisebereitschaft/]),
  q('mobility.remote', 'Télétravail', [/remote|hybrid|teletravail|en remoto|homeoffice/]),
  q('source.how_heard', 'Comment avez-vous connu cette offre ?', [/how did you (hear|find|learn)|where did you (hear|find|see)|source of (application|referral)|comment avez-vous (connu|trouve|entendu)|par quel (biais|moyen)|como (te enteraste|conociste)|wie sind sie auf|wo haben sie/], [/source|hear/i]),
  q('source.referral', 'Recommandé par un collaborateur', [/referr(ed|al)|recommande par|coopte|cooptation|referido|empfohlen/]),
  q('history.previously_employed', 'Déjà employé par cette entreprise', [/(previously|ever|formerly) (been )?(employed|worked)|worked (for|at) .* before|deja travaille (pour|chez)|ancien (salarie|collaborateur)|trabajado (antes|anteriormente)|bereits (bei|fur)/]),
  q('languages.level', 'Niveau de langue', [/(level|proficiency) (of|in) |fluen(t|cy) in|niveau (de|d.)|speak |parlez-vous|nivel de|sprachkenntnisse|english|anglais|francais|french|german|allemand|spanish|espagnol|italian|italien|dutch|neerlandais|luxembourg/]),
];

export const CANONICAL_BY_KEY = new Map(CANONICAL.map((c) => [c.key, c]));

const LEGAL = /i (hereby )?(certify|confirm|declare|attest|acknowledge)|je (certifie|declare|atteste|confirme)|certifico|declaro|ich (bestatige|versichere)|true and (complete|correct|accurate)|exactitude|veracite/;
const PRIVACY = /privacy|confidentialite|donnees personnelles|personal data|data protection|datenschutz|privacidad|gdpr|rgpd|politique de protection/;
const MARKETING = /newsletter|talent (pool|community|network)|future (opportunities|openings)|keep me (informed|updated)|vivier|opportunites futures|marketing|me tenir informe/;
const DEMOGRAPHIC = /gender|genre|sexe|race|ethnic|ethnie|veteran|disabilit|handicap|sexual orientation|orientation sexuelle|hispanic|latino|transgender|age range|tranche d.age|eeo|self.?identif|diversity|diversite/;

export interface FieldClass {
  canonical: CanonicalQuestion | null;
  file: FileRole | null;
  consent: ConsentKind | null;
  demographic: boolean;
}

export const normLabel = (s: string) => normalize(s.replace(/\*+/g, ' ')).replace(/\s+/g, ' ').trim();

/** Rattache un champ à une question connue (par son libellé, puis par ses attributs techniques). */
export function classifyField(f: FormField): FieldClass {
  const label = normLabel(f.label || f.placeholder || '');
  const tech = `${f.name} ${f.id} ${f.autocomplete}`;
  if (f.type === 'file') {
    const what = `${label} ${tech.toLowerCase()}`;
    const file: FileRole = /cover|motivation|lettre|anschreiben|carta/.test(what) ? 'cover_letter' : /resume|cv\b|curriculum|lebenslauf|^cv|_cv|cv_|systemfield_resume/.test(what) || !/(other|autre|additional|transcript|portfolio)/.test(what) ? 'resume' : 'other';
    return { canonical: null, file, consent: null, demographic: false };
  }
  if (DEMOGRAPHIC.test(label)) return { canonical: null, file: null, consent: null, demographic: true };
  if (f.type === 'checkbox' && !f.options.length) {
    if (PRIVACY.test(label)) return { canonical: null, file: null, consent: 'privacy', demographic: false };
    if (LEGAL.test(label)) return { canonical: null, file: null, consent: 'accuracy', demographic: false };
    if (MARKETING.test(label)) return { canonical: null, file: null, consent: 'marketing', demographic: false };
  }
  if (LEGAL.test(label) && (f.type === 'checkbox' || f.options.length)) return { canonical: null, file: null, consent: 'accuracy', demographic: false };
  // Libellé d'abord : il porte le sens. Attributs techniques ensuite (un « name="email" » sans libellé).
  for (const c of CANONICAL) if (c.patterns.some((p) => p.test(label))) return { canonical: c, file: null, consent: null, demographic: false };
  if (!label || label.length < 3) for (const c of CANONICAL) if (c.hints?.some((h) => h.test(tech))) return { canonical: c, file: null, consent: null, demographic: false };
  if (f.autocomplete) {
    const ac: Record<string, string> = { 'given-name': 'identity.first_name', 'family-name': 'identity.last_name', name: 'identity.full_name', email: 'contact.email', tel: 'contact.phone', 'postal-code': 'contact.postal_code', 'address-level2': 'contact.city', 'country-name': 'contact.country', country: 'contact.country', 'street-address': 'contact.address', 'address-line1': 'contact.address', organization: 'work.current_company', 'organization-title': 'work.current_title', url: 'links.website' };
    const key = ac[f.autocomplete.toLowerCase()];
    if (key) return { canonical: CANONICAL_BY_KEY.get(key)!, file: null, consent: null, demographic: false };
  }
  return { canonical: null, file: null, consent: null, demographic: false };
}

// ── Correspondance d'une réponse avec les options d'une liste ──

const YES = /^(yes|oui|si|sí|ja|y|true|vrai|1)$/;
const NO = /^(no|non|nein|n|false|faux|0)$/;

function yesNoOf(v: string): 'yes' | 'no' | null {
  const n = normLabel(v);
  if (YES.test(n) || /^(yes|oui|si|ja)\b/.test(n)) return 'yes';
  if (NO.test(n) || /^(no|non|nein)\b/.test(n)) return 'no';
  return null;
}

/**
 * Choisit l'option qui correspond à la réponse. Renvoie null si aucune ne correspond avec
 * certitude : la question sera alors posée plutôt que devinée.
 */
export function matchOption(options: FormOption[], answer: string): FormOption | null {
  const usable = options.filter((o) => o.label.trim() && !/^(select|choose|choisir|selectionner|seleccione|bitte wahlen|--|please select)\b/i.test(normLabel(o.label)));
  const a = normLabel(answer);
  if (!a) return null;
  const exact = usable.find((o) => normLabel(o.label) === a || normLabel(o.value) === a);
  if (exact) return exact;
  const yn = yesNoOf(answer);
  if (yn) {
    const hits = usable.filter((o) => yesNoOf(o.label) === yn);
    if (hits.length === 1) return hits[0]!;
  }
  // Nombre dans une tranche (« 3-5 ans », « 5+ years », « moins de 2 ans »).
  const n = Number(a.replace(',', '.').match(/^\d+(\.\d+)?/)?.[0] ?? NaN);
  if (!Number.isNaN(n)) {
    for (const o of usable) {
      const l = normLabel(o.label);
      const range = /(\d+)\s*(?:-|–|a|to|bis)\s*(\d+)/.exec(l);
      if (range && n >= Number(range[1]) && n <= Number(range[2])) return o;
      const plus = /(\d+)\s*(\+|or more|et plus|ou plus|y mas|und mehr)/.exec(l) ?? /(?:more than|plus de|mas de|mehr als|over)\s*(\d+)/.exec(l);
      if (plus && n >= Number(plus[1])) return o;
      const less = /(?:less than|moins de|menos de|weniger als|under)\s*(\d+)/.exec(l);
      if (less && n < Number(less[1])) return o;
    }
  }
  const contains = usable.filter((o) => {
    const l = normLabel(o.label);
    return l.length >= 2 && (l.includes(a) || (a.length >= 4 && a.includes(l)));
  });
  if (contains.length === 1) return contains[0]!;
  return null;
}

/** Option « je ne souhaite pas répondre » d'un questionnaire de diversité. */
export function declineOption(options: FormOption[]): FormOption | null {
  return options.find((o) => /decline|prefer not|not (wish|want) to|don.?t wish|ne (souhaite|veux) pas|pas de reponse|prefiero no|keine angabe|ich mochte (das|dies) nicht/.test(normLabel(o.label))) ?? null;
}
