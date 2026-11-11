// Comparaison LinkedIn ↔ CV master. Purement déterministe. Ne remonte que les
// écarts significatifs (pas les différences de casse, d'accents ou de mise en forme)
// et ne tranche jamais : chaque écart est soumis à l'utilisateur.
import { coverage, normalize, tokenSimilarity, tokens } from '../../core/text.js';
import { type CvData, type Experience, cvToText, fmtDate } from '../../shared/cv.js';
import { samePartialDate } from '../dates.js';

export type DiffKind =
  | 'experience_missing_in_cv'
  | 'experience_missing_in_linkedin'
  | 'title_mismatch'
  | 'date_mismatch'
  | 'new_responsibilities'
  | 'education_missing_in_cv'
  | 'education_missing_in_linkedin'
  | 'education_mismatch'
  | 'new_skills'
  | 'certification_missing_in_cv'
  | 'language_missing_in_cv'
  | 'language_level_mismatch';

export interface ProfileDiff {
  kind: DiffKind;
  dedupKey: string;
  summary: string;
  cvValue: unknown;
  linkedinValue: unknown;
  /** Modification du CV master proposée si l'utilisateur accepte (absente = simple information). */
  proposal?: Record<string, unknown>;
}

const LEGAL_SUFFIX = /\b(sa|sas|sasu|sarl|ltd|limited|llp|llc|inc|plc|gmbh|ag|bv|nv|spa|srl|group|groupe|france|uk|international|and co|co|company|cie)\b/g;
const companyKey = (name: string) => normalize(name).replace(LEGAL_SUFFIX, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function sameCompany(a: string, b: string): boolean {
  const ka = companyKey(a);
  const kb = companyKey(b);
  if (!ka || !kb) return false;
  if (ka === kb || ka.includes(kb) || kb.includes(ka)) return true;
  return tokenSimilarity(ka, kb) >= 0.6;
}

/** Deux intitulés désignent le même poste s'ils sont proches, ou si l'un n'est qu'une version plus détaillée de l'autre. */
export function sameTitle(a: string, b: string): boolean {
  if (normalize(a) === normalize(b)) return true;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  return inter / Math.min(ta.size, tb.size) >= 0.99 || inter / (ta.size + tb.size - inter) >= 0.8;
}

const period = (e: { start: string; end: string }) => [fmtDate(e.start), fmtDate(e.end)].filter(Boolean).join(' – ');
const expLabel = (e: Experience) => `${e.title} — ${e.company}${period(e) ? ` (${period(e)})` : ''}`;

function overlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  const y = (d: string, fallback: number) => (d === 'present' ? 9999 : /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : fallback);
  return y(a.start, 0) <= y(b.end, 9999) && y(b.start, 0) <= y(a.end, 9999);
}

export function diffProfile(master: CvData, li: CvData): ProfileDiff[] {
  const out: ProfileDiff[] = [];
  const cvText = cvToText(master);
  const cvTokens = new Set(tokens(cvText));

  // ── Expériences ──
  const used = new Set<string>();
  for (const le of li.experiences) {
    const candidates = master.experiences.filter((ce) => !used.has(ce.id) && sameCompany(ce.company, le.company));
    const match =
      candidates.find((ce) => tokenSimilarity(ce.title, le.title) >= 0.5 && overlap(ce, le)) ??
      candidates.find((ce) => overlap(ce, le)) ??
      candidates.find((ce) => tokenSimilarity(ce.title, le.title) >= 0.5);
    const key = `${companyKey(le.company)}|${normalize(le.title)}|${le.start}`;
    if (!match) {
      out.push({
        kind: 'experience_missing_in_cv',
        dedupKey: `exp_missing_cv:${key}`,
        summary: `Expérience présente sur LinkedIn mais absente du CV : ${expLabel(le)}`,
        cvValue: null,
        linkedinValue: le,
        proposal: { action: 'add_experience', experience: le },
      });
      continue;
    }
    used.add(match.id);
    if (!sameTitle(match.title, le.title)) {
      out.push({
        kind: 'title_mismatch',
        dedupKey: `title:${match.id}:${normalize(le.title)}`,
        summary: `Intitulé de poste différent chez ${match.company} : « ${match.title} » sur le CV, « ${le.title} » sur LinkedIn`,
        cvValue: match.title,
        linkedinValue: le.title,
        proposal: { action: 'set_experience_field', experienceId: match.id, field: 'title', value: le.title },
      });
    }
    for (const f of ['start', 'end'] as const) {
      if (match[f] && le[f] && !samePartialDate(match[f], le[f])) {
        out.push({
          kind: 'date_mismatch',
          dedupKey: `date:${match.id}:${f}:${le[f]}`,
          summary: `Date de ${f === 'start' ? 'début' : 'fin'} incohérente pour « ${match.title} — ${match.company} » : ${fmtDate(match[f])} sur le CV, ${fmtDate(le[f])} sur LinkedIn`,
          cvValue: match[f],
          linkedinValue: le[f],
          proposal: { action: 'set_experience_field', experienceId: match.id, field: f, value: le[f] },
        });
      }
    }
    const liText = le.bullets.map((b) => b.text).join(' ');
    if (liText.length >= 150) {
      const expTokens = new Set(tokens([match.summary, ...match.bullets.map((b) => b.text)].join(' ')));
      const fresh = le.bullets.filter((b) => b.text.length > 30 && coverage(b.text, expTokens) < 0.5);
      if (fresh.length) {
        out.push({
          kind: 'new_responsibilities',
          dedupKey: `resp:${match.id}:${normalize(fresh.map((b) => b.text).join(' ')).slice(0, 120)}`,
          summary: `LinkedIn décrit pour « ${match.title} — ${match.company} » des missions absentes du CV (${fresh.length})`,
          cvValue: match.bullets.map((b) => b.text),
          linkedinValue: fresh.map((b) => b.text),
          proposal: { action: 'add_bullets', experienceId: match.id, bullets: fresh.map((b) => b.text) },
        });
      }
    }
  }
  for (const ce of master.experiences) {
    if (used.has(ce.id)) continue;
    out.push({
      kind: 'experience_missing_in_linkedin',
      dedupKey: `exp_missing_li:${ce.id}:${companyKey(ce.company)}`,
      summary: `Expérience présente sur le CV mais absente de LinkedIn : ${expLabel(ce)}`,
      cvValue: ce,
      linkedinValue: null,
    });
  }

  // ── Formation ──
  const usedEdu = new Set<string>();
  for (const le of li.education) {
    const match = master.education.find((ce) => !usedEdu.has(ce.id) && (sameCompany(ce.school, le.school) || tokenSimilarity(ce.school, le.school) >= 0.5));
    if (!match) {
      out.push({
        kind: 'education_missing_in_cv',
        dedupKey: `edu_missing_cv:${normalize(le.school)}|${normalize(le.degree)}`,
        summary: `Formation présente sur LinkedIn mais absente du CV : ${[le.degree, le.school].filter(Boolean).join(' — ')}`,
        cvValue: null,
        linkedinValue: le,
        proposal: { action: 'add_education', education: le },
      });
      continue;
    }
    usedEdu.add(match.id);
    for (const f of ['start', 'end'] as const) {
      if (match[f] && le[f] && !samePartialDate(match[f], le[f])) {
        out.push({
          kind: 'education_mismatch',
          dedupKey: `edu_date:${match.id}:${f}:${le[f]}`,
          summary: `Date de ${f === 'start' ? 'début' : 'fin'} incohérente pour « ${match.school} » : ${fmtDate(match[f])} sur le CV, ${fmtDate(le[f])} sur LinkedIn`,
          cvValue: match[f],
          linkedinValue: le[f],
          proposal: { action: 'set_education_field', educationId: match.id, field: f, value: le[f] },
        });
      }
    }
  }
  for (const ce of master.education) {
    if (usedEdu.has(ce.id)) continue;
    out.push({
      kind: 'education_missing_in_linkedin',
      dedupKey: `edu_missing_li:${ce.id}:${normalize(ce.school)}`,
      summary: `Formation présente sur le CV mais absente de LinkedIn : ${[ce.degree, ce.school].filter(Boolean).join(' — ')}`,
      cvValue: ce,
      linkedinValue: null,
    });
  }

  // ── Compétences : un seul écart regroupé, pour ne pas multiplier les demandes ──
  const newSkills = li.skills
    .flatMap((g) => g.items)
    .filter((s) => s.trim().length > 1 && coverage(s, cvTokens) < 1);
  if (newSkills.length) {
    out.push({
      kind: 'new_skills',
      dedupKey: `skills:${newSkills.map((s) => normalize(s)).sort().join('|').slice(0, 300)}`,
      summary: `${newSkills.length} compétence(s) déclarée(s) sur LinkedIn et absente(s) du CV`,
      cvValue: null,
      linkedinValue: newSkills,
      proposal: { action: 'add_skills', skills: newSkills },
    });
  }

  // ── Certifications et langues ──
  for (const lc of li.certifications) {
    if (!lc.name || master.certifications.some((c) => tokenSimilarity(c.name, lc.name) >= 0.6) || coverage(lc.name, cvTokens) >= 0.9) continue;
    out.push({
      kind: 'certification_missing_in_cv',
      dedupKey: `cert:${normalize(lc.name)}`,
      summary: `Certification présente sur LinkedIn mais absente du CV : ${lc.name}${lc.issuer ? ` (${lc.issuer})` : ''}`,
      cvValue: null,
      linkedinValue: lc,
      proposal: { action: 'add_certification', certification: lc },
    });
  }
  for (const ll of li.languages) {
    const match = master.languages.find((l) => languageKey(l.language) === languageKey(ll.language));
    if (!match) {
      out.push({
        kind: 'language_missing_in_cv',
        dedupKey: `lang:${languageKey(ll.language)}`,
        summary: `Langue présente sur LinkedIn mais absente du CV : ${ll.language}${ll.level ? ` (${ll.level})` : ''}`,
        cvValue: null,
        linkedinValue: ll,
        proposal: { action: 'add_language', language: ll },
      });
    } else if (match.level && ll.level && levelRank(match.level) !== null && levelRank(ll.level) !== null && Math.abs(levelRank(match.level)! - levelRank(ll.level)!) >= 2) {
      out.push({
        kind: 'language_level_mismatch',
        dedupKey: `lang_level:${languageKey(ll.language)}:${normalize(ll.level)}`,
        summary: `Niveau de ${match.language} différent : « ${match.level} » sur le CV, « ${ll.level} » sur LinkedIn`,
        cvValue: match.level,
        linkedinValue: ll.level,
      });
    }
  }
  return out;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  francais: 'fr', french: 'fr', frances: 'fr', franzosisch: 'fr',
  anglais: 'en', english: 'en', ingles: 'en', englisch: 'en',
  espagnol: 'es', spanish: 'es', espanol: 'es', spanisch: 'es', castellano: 'es',
  allemand: 'de', german: 'de', aleman: 'de', deutsch: 'de',
  italien: 'it', italian: 'it', italiano: 'it',
  portugais: 'pt', portuguese: 'pt', portugues: 'pt',
  neerlandais: 'nl', dutch: 'nl', nederlands: 'nl',
  chinois: 'zh', chinese: 'zh', mandarin: 'zh',
  arabe: 'ar', arabic: 'ar', japonais: 'ja', japanese: 'ja', russe: 'ru', russian: 'ru', vietnamien: 'vi', vietnamese: 'vi',
};

export function languageKey(name: string): string {
  const n = normalize(name).split(' ')[0] ?? '';
  return LANGUAGE_ALIASES[n] ?? n;
}

/** Échelle approximative 1 (notions) → 5 (langue maternelle) ; null si le niveau est illisible. */
export function levelRank(level: string): number | null {
  const n = normalize(level);
  if (/\b(native|maternelle|bilingue|bilingual|c2|mother tongue|nativo)\b/.test(n)) return 5;
  if (/\b(full professional|courant|fluent|c1|fluide|avance|advanced)\b/.test(n)) return 4;
  if (/\b(professional working|professionnel|b2|operationnel|intermediaire avance|upper intermediate)\b/.test(n)) return 3;
  if (/\b(limited working|intermediaire|intermediate|b1)\b/.test(n)) return 2;
  if (/\b(elementary|notions|debutant|beginner|a1|a2|scolaire|basic)\b/.test(n)) return 1;
  return null;
}
