// Réponses aux champs d'un formulaire de candidature.
//
// Pour chaque champ : la réponse, sa source (profil validé, réponse déjà donnée,
// document validé, déduction factuelle, réglage) et son statut. Rien n'est inventé :
// une information inconnue devient une question posée une seule fois à l'utilisateur ;
// une déclaration juridique ou une donnée sensible non autorisée reste à l'utilisateur.
import type { UserContext } from '../core/context.js';
import { normalize } from '../core/text.js';
import { findAnswer, recordAnswerUse } from '../profile/answers.js';
import { factsMap } from '../profile/facts.js';
import type { CvVersion } from '../profile/cv.js';
import { countryCodeOf, countryNames } from '../search/normalize.js';
import type { SalaryExpectation } from '../shared/facts.js';
import type { SettingValue } from '../shared/settings.js';
import type { Job } from '../tracker/stage.js';
import { classifyField, declineOption, type FormField, type FormOption, matchOption, normLabel } from './questions.js';

export type AnswerSource = 'profile' | 'answers' | 'document' | 'derived' | 'cv' | 'letter' | 'setting' | 'none';
export type AnswerStatus = 'ready' | 'missing' | 'needs_human' | 'skipped';

export interface ResolvedField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  canonical: string | null;
  /** Valeur à saisir : texte, valeur d'option, liste de valeurs, case cochée, ou identifiant de fichier. */
  value: string | string[] | boolean | null;
  /** Réponse lisible (libellé de l'option choisie, nom du fichier…). */
  display: string;
  source: AnswerSource;
  sourceRef: string;
  status: AnswerStatus;
  /** Pourquoi la réponse manque, ou pourquoi elle revient à l'utilisateur. */
  reason?: string;
  /** Réponse proposée à confirmer (ex. donnée sensible connue du profil). */
  suggestion?: string;
  sensitive?: boolean;
  /** Question à poser telle quelle à l'utilisateur et portée conseillée de sa réponse. */
  ask?: { question: string; scope: 'general' | 'country' | 'company' | 'job'; options: FormOption[] };
}

export interface ApplicationDocs {
  resume: { fileId: string; filename: string } | null;
  coverLetter: { fileId: string; filename: string } | null;
  /** Versions Word, pour les formulaires qui n'acceptent pas le PDF. */
  resumeDocx?: { fileId: string; filename: string } | null;
  coverLetterDocx?: { fileId: string; filename: string } | null;
  /** Texte de la lettre validée (questions « lettre de motivation » en champ texte). */
  letterText: string;
}

export interface ResolveInput {
  job: Pick<Job, 'id' | 'companyName' | 'country' | 'title'>;
  cv: Pick<CvVersion, 'data'> | null;
  docs: ApplicationDocs;
  autopilot: SettingValue<'application.autopilot'>;
  /** Source réelle de l'offre (« LinkedIn », « Welcome to the Jungle », « Site carrières »…). */
  sourceLabel: string;
}

const EU_EEA = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO']);
const REGION_WORDS: { re: RegExp; codes: Set<string> | null }[] = [
  { re: /union europeenne|european union|\bue\b|\beu\b|espace economique europeen|\beee\b|\beea\b/, codes: EU_EEA },
];

function codesOf(list: unknown): Set<string> {
  const out = new Set<string>();
  const items = Array.isArray(list) ? list.map(String) : typeof list === 'string' ? list.split(/[,;\n]/) : [];
  for (const raw of items) {
    const t = raw.trim();
    if (!t) continue;
    const region = REGION_WORDS.find((r) => r.re.test(normalize(t)));
    if (region?.codes) for (const c of region.codes) out.add(c);
    const code = countryCodeOf(t);
    if (code) out.add(code);
  }
  return out;
}

const asText = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : v == null ? '' : String(v));

function salaryFor(list: unknown, country: string): SalaryExpectation | null {
  const all = Array.isArray(list) ? (list as SalaryExpectation[]) : [];
  const exact = all.find((s) => countryCodeOf(s.country ?? '') === country);
  return exact ?? null;
}

function fmtSalary(s: SalaryExpectation): string {
  const n = (x: number | null) => (x == null ? '' : x.toLocaleString('fr-FR'));
  const range = s.min != null && s.max != null && s.max !== s.min ? `${n(s.min)} – ${n(s.max)}` : n(s.min ?? s.max);
  return `${range} ${s.currency}${s.period === 'month' ? ' / mois' : ' / an'}`;
}

/** Langue citée dans un libellé et niveau déclaré dans le profil (« Anglais : courant (C1) »). */
function languageLevel(label: string, languages: unknown): string | null {
  const l = normLabel(label);
  const names: Record<string, RegExp> = {
    english: /english|anglais|ingles|englisch/,
    french: /french|francais|frances|franzosisch/,
    german: /german|allemand|aleman|deutsch/,
    spanish: /spanish|espagnol|espanol|spanisch/,
    italian: /italian|italien|italiano/,
    dutch: /dutch|neerlandais|neerlandes|niederlandisch/,
    luxembourgish: /luxembourg/,
    portuguese: /portugu/,
  };
  const wanted = Object.entries(names).find(([, re]) => re.test(l));
  if (!wanted) return null;
  const items = Array.isArray(languages) ? languages.map(String) : typeof languages === 'string' ? languages.split(/[,;\n]/) : [];
  const hit = items.find((i) => wanted[1].test(normLabel(i)));
  if (!hit) return null;
  return hit.replace(/^[^:(–-]*[:(–-]\s*/, '').replace(/\)\s*$/, '').trim() || hit.trim();
}

const MOTIVATION = /cover letter|lettre de motivation|motivation|why (do you want|are you interested|this (role|company))|pourquoi (souhaitez|voulez|ce poste|nous)|additional information|informations complementaires|message (to|au) (the )?(hiring|recruteur)|anschreiben|carta de presentacion/;

/**
 * Détermine la réponse de chaque champ. Ne modifie rien : le résultat sert à remplir le
 * formulaire, à lister les questions à poser, et à mesurer le taux de remplissage.
 */
export async function resolveFields(ctx: UserContext, fields: FormField[], input: ResolveInput): Promise<ResolvedField[]> {
  const facts = await factsMap(ctx.db, ctx.userId);
  const fact = (k: string) => facts.get(k)?.value;
  const country = (input.job.country || '').toUpperCase();
  const where = { jobId: input.job.id, company: input.job.companyName, country };
  const identity = input.cv?.data.identity;
  const auth = codesOf(fact('eligibility.work_authorization'));
  const needsVisa = codesOf(fact('eligibility.sponsorship_needed'));
  const ap = input.autopilot;
  const out: ResolvedField[] = [];

  for (const f of fields) {
    const cls = classifyField(f);
    const base = { key: f.key, label: f.label || f.placeholder || f.name, type: f.type, required: f.required, canonical: cls.canonical?.key ?? null };
    const done = (r: Omit<ResolvedField, keyof typeof base>) => out.push({ ...base, ...r });
    const missing = (reason: string, scope: NonNullable<ResolvedField['ask']>['scope'] = 'general', suggestion?: string, sensitive?: boolean) =>
      done({ value: null, display: '', source: 'none', sourceRef: '', status: f.required ? 'missing' : 'skipped', reason, suggestion, sensitive, ask: { question: cls.canonical?.ask && !cls.canonical.perCountry ? cls.canonical.ask : base.label, scope, options: f.options } });

    // ── Pièces jointes : uniquement les documents validés de CETTE candidature.
    if (cls.file) {
      const accept = (f.accept || '').toLowerCase();
      const pdfOk = !accept || /pdf|\*/.test(accept);
      const wordOk = /docx?|word|officedocument/.test(accept);
      const pick = (pdf: ApplicationDocs['resume'], docx: ApplicationDocs['resume'] | undefined) => (pdfOk ? pdf : wordOk ? (docx ?? null) : null);
      const doc = cls.file === 'resume' ? pick(input.docs.resume, input.docs.resumeDocx) : cls.file === 'cover_letter' ? pick(input.docs.coverLetter, input.docs.coverLetterDocx) : null;
      if (!doc && accept && !pdfOk && !wordOk) {
        missing(`Le formulaire n'accepte que : ${f.accept}. Aucun de vos documents n'a ce format.`);
        continue;
      }
      if (doc) done({ value: doc.fileId, display: doc.filename, source: 'document', sourceRef: doc.fileId, status: 'ready' });
      else if (cls.file === 'cover_letter') missing('Aucune lettre validée pour cette candidature.');
      else missing('Document demandé non disponible.');
      continue;
    }

    // ── Consentements et déclarations : jamais cochés sans autorisation préalable explicite.
    if (cls.consent) {
      const allowed = (cls.consent === 'privacy' && ap.consents.privacyPolicy) || (cls.consent === 'accuracy' && ap.consents.accuracyAttestation);
      if (allowed) done({ value: true, display: 'Coché (autorisé dans vos règles)', source: 'setting', sourceRef: `consents.${cls.consent === 'privacy' ? 'privacyPolicy' : 'accuracyAttestation'}`, status: 'ready' });
      else if (cls.consent === 'marketing' || !f.required) done({ value: false, display: 'Non coché', source: 'setting', sourceRef: 'consents', status: 'skipped' });
      else done({ value: null, display: '', source: 'none', sourceRef: '', status: 'needs_human', reason: cls.consent === 'privacy' ? 'Acceptation de la politique de confidentialité du recruteur : à cocher par vous, ou à autoriser une fois dans vos règles AUTOPILOT.' : 'Déclaration sur l’honneur : à cocher par vous, ou à autoriser une fois dans vos règles AUTOPILOT.' });
      continue;
    }

    // ── Questionnaires de diversité : « je ne souhaite pas répondre » si vous l'avez choisi.
    if (cls.demographic) {
      const decline = ap.consents.declineDemographics ? declineOption(f.options) : null;
      if (decline) done({ value: decline.value, display: decline.label, source: 'setting', sourceRef: 'consents.declineDemographics', status: 'ready' });
      else if (!f.required) done({ value: null, display: '', source: 'none', sourceRef: '', status: 'skipped', reason: 'Question facultative de diversité : laissée sans réponse.' });
      else missing('Question de diversité obligatoire, sans option « ne souhaite pas répondre ».', 'general', undefined, true);
      continue;
    }

    // ── Réponse explicite déjà donnée pour cette offre, cette entreprise ou ce pays : elle prime.
    const qa = await findAnswer(ctx.db, ctx.userId, base.label, where);
    if (qa && qa.answer.scope !== 'general') {
      await pushAnswer(f, qa.answer.answer, 'answers', qa.answer.id, done, missing);
      await recordAnswerUse(ctx.db, qa.answer, base.label);
      continue;
    }

    // ── Questions connues : profil validé, CV, déduction factuelle.
    let value: string | null = null;
    let source: AnswerSource = 'profile';
    let sourceRef = '';
    let suggestion: string | undefined;
    let scope: NonNullable<ResolvedField['ask']>['scope'] = 'general';
    let reason = 'Information absente de votre profil.';
    const fromFact = (k: string) => {
      const v = asText(fact(k)).trim();
      if (v) {
        value = v;
        source = 'profile';
        sourceRef = k;
      }
    };
    switch (cls.canonical?.key) {
      case 'identity.first_name':
        fromFact('contact.first_name');
        break;
      case 'identity.last_name':
        fromFact('contact.last_name');
        break;
      case 'identity.full_name':
      case 'identity.preferred_name': {
        const first = asText(fact('contact.first_name')).trim();
        const last = asText(fact('contact.last_name')).trim();
        if (cls.canonical.key === 'identity.preferred_name' && first) [value, source, sourceRef] = [first, 'profile', 'contact.first_name'];
        else if (first && last) [value, source, sourceRef] = [`${first} ${last}`, 'profile', 'contact.first_name+contact.last_name'];
        else if (identity?.fullName) [value, source, sourceRef] = [identity.fullName, 'cv', 'identity.fullName'];
        break;
      }
      case 'contact.email':
        fromFact('contact.email');
        break;
      case 'contact.phone':
        fromFact('contact.phone');
        break;
      case 'contact.phone_country': {
        const phone = asText(fact('contact.phone'));
        const dial = /^\+(\d{1,3})/.exec(phone.replace(/\s/g, ''))?.[1];
        if (dial) {
          const opt = f.options.find((o) => new RegExp(`\\+\\s?${dial}\\b`).test(o.label)) ?? null;
          if (opt) {
            done({ value: opt.value, display: opt.label, source: 'derived', sourceRef: 'contact.phone', status: 'ready' });
            continue;
          }
          value = `+${dial}`;
          source = 'derived';
          sourceRef = 'contact.phone';
        }
        break;
      }
      case 'contact.postal_code':
        fromFact('contact.postal_code');
        break;
      case 'contact.address':
        fromFact('contact.address');
        break;
      case 'contact.city':
        fromFact('contact.city');
        break;
      case 'contact.country':
        fromFact('contact.country');
        break;
      case 'links.linkedin':
        fromFact('contact.linkedin_url');
        if (!value && identity?.linkedin) [value, source, sourceRef] = [identity.linkedin, 'cv', 'identity.linkedin'];
        break;
      case 'links.website':
        fromFact('contact.website');
        break;
      case 'work.current_company':
        fromFact('background.current_employer');
        break;
      case 'work.current_title':
        fromFact('background.current_title');
        break;
      case 'work.years_experience':
        fromFact('background.years_experience');
        break;
      case 'education.school':
        fromFact('background.school');
        break;
      case 'education.degree':
        fromFact('background.highest_degree');
        break;
      case 'education.graduation_year':
        fromFact('background.graduation_year');
        break;
      case 'eligibility.work_authorization':
        scope = 'country';
        if (country && auth.has(country)) [value, source, sourceRef] = ['Oui', 'profile', 'eligibility.work_authorization'];
        else if (country && needsVisa.has(country)) [value, source, sourceRef] = ['Non', 'profile', 'eligibility.sponsorship_needed'];
        else reason = `Votre droit au travail${country ? ` pour ce pays (${country})` : ''} n'est pas renseigné.`;
        break;
      case 'eligibility.sponsorship':
        scope = 'country';
        if (country && auth.has(country)) [value, source, sourceRef] = ['Non', 'profile', 'eligibility.work_authorization'];
        else if (country && needsVisa.has(country)) [value, source, sourceRef] = ['Oui', 'profile', 'eligibility.sponsorship_needed'];
        else reason = `Votre besoin de visa${country ? ` pour ce pays (${country})` : ''} n'est pas renseigné.`;
        break;
      case 'eligibility.nationality':
      case 'eligibility.date_of_birth': {
        // Donnée sensible : elle n'est transmise qu'après votre confirmation pour les formulaires (réponse enregistrée).
        const k = cls.canonical.key === 'eligibility.nationality' ? 'eligibility.nationalities' : 'eligibility.date_of_birth';
        suggestion = asText(fact(k)) || undefined;
        reason = 'Donnée sensible : confirmez une fois qu’elle peut être communiquée dans les formulaires.';
        break;
      }
      case 'eligibility.driving_license':
        fromFact('eligibility.driving_license');
        break;
      case 'availability.notice_period':
        fromFact('availability.notice_period');
        break;
      case 'availability.start_date':
        fromFact('availability.start_date');
        break;
      case 'compensation.expected': {
        scope = 'country';
        const s = country ? salaryFor(fact('compensation.expectations'), country) : null;
        if (s) {
          value = f.type === 'number' ? String(s.min ?? s.max ?? '') : fmtSalary(s);
          source = 'profile';
          sourceRef = 'compensation.expectations';
        } else reason = `Aucune prétention salariale validée${country ? ` pour ce pays (${country})` : ''}.`;
        break;
      }
      case 'compensation.current':
        suggestion = asText(fact('compensation.current')) || undefined;
        reason = 'Rémunération actuelle : communiquée uniquement si vous le confirmez.';
        break;
      case 'mobility.relocation':
        fromFact('mobility.relocation');
        break;
      case 'mobility.travel':
        fromFact('mobility.travel');
        break;
      case 'mobility.remote':
        fromFact('preferences.remote');
        break;
      case 'source.how_heard':
        fromFact('preferences.how_heard');
        if (!value && ap.allowDerivedAnswers && input.sourceLabel) [value, source, sourceRef] = [input.sourceLabel, 'derived', 'job.source'];
        break;
      case 'history.previously_employed': {
        if (ap.allowDerivedAnswers && input.cv) {
          const company = normalize(input.job.companyName).split(' ')[0] ?? '';
          const worked = company.length >= 3 && input.cv.data.experiences.some((e) => normalize(e.company ?? '').includes(company));
          [value, source, sourceRef] = [worked ? 'Oui' : 'Non', 'cv', 'experiences'];
        }
        break;
      }
      case 'languages.level': {
        const level = languageLevel(base.label, fact('background.languages'));
        if (level) [value, source, sourceRef] = [level, 'profile', 'background.languages'];
        break;
      }
      default:
        break;
    }

    // ── Questions libres : lettre validée pour les questions de motivation, réponses déjà données sinon.
    if (value == null && !cls.canonical && (f.tag === 'textarea' || f.type === 'text') && MOTIVATION.test(normLabel(base.label))) {
      if (ap.allowLetterAnswers && input.docs.letterText.trim()) {
        const text = input.docs.letterText.trim();
        if (!f.maxLength || text.length <= f.maxLength) [value, source, sourceRef] = [text, 'letter', 'letter'];
        else reason = `Votre lettre (${text.length} caractères) dépasse la limite du champ (${f.maxLength}).`;
      } else if (!f.required) {
        done({ value: null, display: '', source: 'none', sourceRef: '', status: 'skipped', reason: 'Question facultative de motivation : laissée vide (réponses rédigées non autorisées dans vos règles).' });
        continue;
      }
    }
    if (value == null && qa) {
      await pushAnswer(f, qa.answer.answer, 'answers', qa.answer.id, done, missing);
      await recordAnswerUse(ctx.db, qa.answer, base.label);
      continue;
    }
    if (value == null) {
      if (!cls.canonical && !f.required) {
        done({ value: null, display: '', source: 'none', sourceRef: '', status: 'skipped', reason: 'Champ facultatif sans réponse connue : laissé vide.' });
        continue;
      }
      missing(cls.canonical ? reason : 'Question propre à ce recruteur, jamais rencontrée.', cls.canonical?.perCountry ? 'country' : scope, suggestion, cls.canonical?.sensitive);
      continue;
    }
    await pushAnswer(f, value, source, sourceRef, done, missing);
  }
  return out;
}

/** Traduit une réponse en action sur le champ (texte, option, case), ou en question si elle ne correspond à aucune option. */
async function pushAnswer(
  f: FormField,
  answer: string,
  source: AnswerSource,
  sourceRef: string,
  done: (r: Omit<ResolvedField, 'key' | 'label' | 'type' | 'required' | 'canonical'>) => void,
  missing: (reason: string, scope?: 'general' | 'country' | 'company' | 'job') => void,
): Promise<void> {
  if (f.type === 'checkbox' && !f.options.length) {
    const yes = /^(oui|yes|true|vrai|si|ja|1)$/i.test(answer.trim());
    const no = /^(non|no|false|faux|nein|0)$/i.test(answer.trim());
    if (!yes && !no) return missing(`Réponse « ${answer} » inapplicable à une case à cocher.`);
    return done({ value: yes, display: yes ? 'Coché' : 'Non coché', source, sourceRef, status: 'ready' });
  }
  if (f.options.length || f.type === 'select-one' || f.type === 'radio' || f.tag === 'select') {
    if (f.multiple || f.type === 'checkbox') {
      const parts = answer.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
      const hits = parts.map((p) => matchOption(f.options, p)).filter((o): o is FormOption => Boolean(o));
      if (!hits.length || hits.length < parts.length) return missing(`Aucune option ne correspond avec certitude à « ${answer} ».`);
      return done({ value: hits.map((h) => h.value), display: hits.map((h) => h.label).join(', '), source, sourceRef, status: 'ready' });
    }
    // Pays : une option « France » répond à « FR » et inversement.
    let opt = matchOption(f.options, answer);
    if (!opt) {
      const code = countryCodeOf(answer);
      if (code) opt = f.options.find((o) => countryCodeOf(o.label) === code || countryNames(code).includes(normalize(o.label))) ?? null;
    }
    if (!opt) return missing(`Aucune option ne correspond avec certitude à « ${answer} » : choisissez-la une fois, elle sera retenue.`);
    return done({ value: opt.value, display: opt.label, source, sourceRef, status: 'ready' });
  }
  if (f.type === 'number') {
    const n = answer.replace(/\s/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/)?.[0];
    if (!n) return missing(`Le champ attend un nombre ; réponse connue : « ${answer} ».`);
    return done({ value: n, display: n, source, sourceRef, status: 'ready' });
  }
  if (f.maxLength && answer.length > f.maxLength) return missing(`La réponse connue (${answer.length} caractères) dépasse la limite du champ (${f.maxLength}).`);
  return done({ value: answer, display: answer.length > 140 ? `${answer.slice(0, 140)}…` : answer, source, sourceRef, status: 'ready' });
}

/** Indicateurs de remplissage d'un formulaire. */
export function fillStats(fields: ResolvedField[]) {
  const total = fields.length;
  const ready = fields.filter((f) => f.status === 'ready').length;
  const requiredOpen = fields.filter((f) => f.required && (f.status === 'missing' || f.status === 'needs_human'));
  return { total, ready, autoRate: total ? Math.round((ready / total) * 100) : 0, missing: requiredOpen.filter((f) => f.status === 'missing').length, human: requiredOpen.filter((f) => f.status === 'needs_human').length, complete: requiredOpen.length === 0 };
}
