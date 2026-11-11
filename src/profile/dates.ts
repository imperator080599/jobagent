// Dates partielles de CV (« Sept. 2021 », « 09/2021 », « 2021 », « Aujourd'hui »)
// ramenées au format interne AAAA-MM / AAAA / present.
import { normalize } from '../core/text.js';

const MONTHS: Record<string, string> = {};
const add = (mm: string, ...names: string[]) => names.forEach((n) => (MONTHS[n] = mm));
add('01', 'janvier', 'janv', 'jan', 'january', 'enero', 'ene', 'januar');
add('02', 'fevrier', 'fevr', 'fev', 'february', 'feb', 'febrero', 'februar');
add('03', 'mars', 'mar', 'march', 'marzo', 'marz', 'maerz');
add('04', 'avril', 'avr', 'april', 'apr', 'abril', 'abr');
add('05', 'mai', 'may', 'mayo');
add('06', 'juin', 'june', 'jun', 'junio', 'juni');
add('07', 'juillet', 'juil', 'july', 'jul', 'julio', 'juli');
add('08', 'aout', 'august', 'aug', 'agosto', 'ago');
add('09', 'septembre', 'sept', 'sep', 'september', 'septiembre', 'set');
add('10', 'octobre', 'oct', 'october', 'octubre', 'oktober', 'okt');
add('11', 'novembre', 'nov', 'november', 'noviembre');
add('12', 'decembre', 'dec', 'december', 'diciembre', 'dic', 'dezember', 'dez');

const PRESENT = /^(present|presente|aujourd'?hui|actuel(?:lement)?|en cours|ce jour|now|current(?:ly)?|today|heute|actualidad|en poste|ongoing|a ce jour)$/;

/** « Septembre 2021 » → « 2021-09 » ; « 2021 » → « 2021 » ; « Aujourd'hui » → « present » ; inconnu → « ». */
export function parsePartialDate(input: string | null | undefined): string {
  if (!input) return '';
  const s = normalize(String(input)).replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (PRESENT.test(s)) return 'present';
  let m = /^((?:19|20)\d{2})[-/ ](0[1-9]|1[0-2])(?:[-/ ]\d{1,2})?$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(0?[1-9]|1[0-2])[-/ ]((?:19|20)\d{2})$/.exec(s);
  if (m) return `${m[2]}-${m[1]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[-/ ](0?[1-9]|1[0-2])[-/ ]((?:19|20)\d{2})$/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}`;
  m = /^(?:\d{1,2} )?([a-z]+) ((?:19|20)\d{2})$/.exec(s);
  if (m && MONTHS[m[1]!]) return `${m[2]}-${MONTHS[m[1]!]}`;
  m = /^((?:19|20)\d{2})$/.exec(s);
  if (m) return m[1]!;
  m = /((?:19|20)\d{2})/.exec(s);
  return m ? m[1]! : '';
}

// Motifs appliqués directement au texte d'origine (accents et tirets typographiques compris).
const MONTH_PATTERN =
  "janv(?:ier)?|jan(?:uary|uar)?|f[ée]vr?(?:ier)?|feb(?:ruary|ruar|rero)?|mars|marzo|m[äa]rz|mar(?:ch)?|avr(?:il)?|apr(?:il)?|abr(?:il)?|mai|mayo|may|juin|juni?o?|june?|juil(?:let)?|juli?o?|july?|ao[uû]t|aug(?:ust)?|agosto|sept?(?:embre|ember|iembre)?|oct(?:obre|ober|ubre)?|okt(?:ober)?|nov(?:embre|ember|iembre)?|d[ée]c(?:embre)?|dec(?:ember)?|dic(?:iembre)?|dez(?:ember)?|enero";
const YEAR = '(?:19|20)\\d{2}';
const DATE_TOKEN = `(?:(?:${MONTH_PATTERN})\\.?\\s+${YEAR}|(?:0?[1-9]|1[0-2])\\s?[/.]\\s?${YEAR}|${YEAR}\\s?[/.]\\s?(?:0[1-9]|1[0-2])|${YEAR})`;
const PRESENT_TOKEN = "(?:pr[ée]sente?|aujourd['’]?hui|actuel(?:lement)?|en cours|ce jour|à ce jour|en poste|now|current(?:ly)?|today|ongoing|heute|actualidad)";
const SEPARATOR = "\\s*(?:[-–—−]|\\s(?:to|until|till|à|au|a|jusqu['’]?(?:à|a|en)|hasta|bis)\\s)\\s*";
const NOT_AFTER_WORD = '(?<![\\p{L}\\d])';
const NOT_BEFORE_WORD = '(?![\\p{L}\\d])';

/** Période « sept. 2021 – aujourd'hui », « 2017 - 2021 », « 01/2020 à 06/2020 »… */
export const DATE_RANGE_RE = new RegExp(`(?:${NOT_AFTER_WORD}(?:depuis|since|from|de|du|desde|seit)\\s+)?${NOT_AFTER_WORD}(${DATE_TOKEN})${SEPARATOR}(${DATE_TOKEN}|${PRESENT_TOKEN})${NOT_BEFORE_WORD}`, 'iu');
export const SINCE_RE = new RegExp(`${NOT_AFTER_WORD}(?:depuis|since|desde|seit)\\s+(${DATE_TOKEN})${NOT_BEFORE_WORD}`, 'iu');

function cleanRest(s: string): string {
  return s
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s|•·,;:–—-]+|[\s|•·,;:(–—-]+$/g, '')
    .trim();
}

/** Extrait la période d'une ligne ; renvoie aussi la ligne débarrassée de la période. */
export function extractDateRange(line: string): { start: string; end: string; rest: string; raw: string } | null {
  let m = DATE_RANGE_RE.exec(line);
  if (m) return { start: parsePartialDate(m[1]), end: parsePartialDate(m[2]), rest: cleanRest(line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length)), raw: m[0].trim() };
  m = SINCE_RE.exec(line);
  if (m) return { start: parsePartialDate(m[1]), end: 'present', rest: cleanRest(line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length)), raw: m[0].trim() };
  return null;
}

/** Compare deux dates partielles avec la précision disponible des deux côtés. */
export function samePartialDate(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  if (a === b) return true;
  if (a === 'present' || b === 'present') return false;
  // Si l'un des deux n'a que l'année, on ne compare que l'année.
  if (a.length === 4 || b.length === 4) return a.slice(0, 4) === b.slice(0, 4);
  return false;
}

export function partialDateToMonths(d: string, now: Date = new Date()): number | null {
  if (!d) return null;
  if (d === 'present') return now.getUTCFullYear() * 12 + now.getUTCMonth();
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(d);
  if (!m) return null;
  return Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0);
}
