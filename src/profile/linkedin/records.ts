// Données LinkedIn → profil structuré. L'archive officielle (« Télécharger vos
// données ») et l'API officielle de portabilité (Member Snapshot API) exposent les
// mêmes enregistrements clé/valeur : un seul convertisseur sert aux deux.
import { unzipSync } from 'fflate';
import { type CvData, assignIds, emptyCv } from '../../shared/cv.js';
import { parsePartialDate } from '../dates.js';

export type LinkedinRecords = Record<string, Record<string, string>[]>;

/** Analyse CSV tolérante (guillemets, retours à la ligne dans les champs, séparateur virgule). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const DOMAIN_FILES: Record<string, { domain: string; header: string }> = {
  'profile.csv': { domain: 'PROFILE', header: 'First Name' },
  'positions.csv': { domain: 'POSITIONS', header: 'Company Name' },
  'education.csv': { domain: 'EDUCATION', header: 'School Name' },
  'skills.csv': { domain: 'SKILLS', header: 'Name' },
  'languages.csv': { domain: 'LANGUAGES', header: 'Name' },
  'certifications.csv': { domain: 'CERTIFICATIONS', header: 'Name' },
  'projects.csv': { domain: 'PROJECTS', header: 'Title' },
  'honors.csv': { domain: 'HONORS', header: 'Title' },
  'courses.csv': { domain: 'COURSES', header: 'Name' },
  'volunteering.csv': { domain: 'VOLUNTEERING_EXPERIENCES', header: 'Company Name' },
  'email addresses.csv': { domain: 'EMAIL_ADDRESSES', header: 'Email Address' },
  'phonenumbers.csv': { domain: 'PHONE_NUMBERS', header: 'Number' },
};

/** Convertit un CSV de l'archive en enregistrements, en ignorant un éventuel préambule avant l'en-tête. */
export function csvToRecords(text: string, headerColumn: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((r) => r.some((c) => c.trim() === headerColumn));
  if (headerIdx < 0) return [];
  const header = rows[headerIdx]!.map((h) => h.trim());
  return rows.slice(headerIdx + 1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Lit l'archive ZIP officielle de LinkedIn. Seuls les fichiers de profil sont lus ; le reste (messages, contacts…) est ignoré. */
export function readLinkedinExport(zip: Uint8Array): LinkedinRecords {
  const wanted = (name: string) => Object.keys(DOMAIN_FILES).includes(name.split('/').pop()!.toLowerCase());
  const entries = unzipSync(zip, { filter: (f) => wanted(f.name) && f.originalSize < 5_000_000 });
  const out: LinkedinRecords = {};
  for (const [name, bytes] of Object.entries(entries)) {
    const def = DOMAIN_FILES[name.split('/').pop()!.toLowerCase()];
    if (!def) continue;
    out[def.domain] = csvToRecords(Buffer.from(bytes).toString('utf8'), def.header);
  }
  return out;
}

const g = (r: Record<string, string> | undefined, ...keys: string[]): string => {
  for (const k of keys) {
    const v = r?.[k];
    if (v && v.trim()) return v.trim();
  }
  return '';
};

/** Découpe une description LinkedIn en éléments (puces ou phrases). */
export function descriptionToBullets(description: string): string[] {
  const lines = description
    .split(/\n+|\s{2,}(?=[•\-–▪◦])/)
    .map((l) => l.replace(/^\s*[•\-–▪◦*·]\s*/, '').trim())
    .filter(Boolean);
  if (lines.length > 1) return lines;
  return description
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

export function recordsToProfile(records: LinkedinRecords): CvData {
  const cv = emptyCv('fr');
  const p = records.PROFILE?.[0];
  cv.identity.fullName = [g(p, 'First Name'), g(p, 'Last Name')].filter(Boolean).join(' ');
  cv.identity.headline = g(p, 'Headline');
  cv.identity.location = g(p, 'Geo Location', 'Address');
  cv.identity.website = g(p, 'Websites').replace(/^\[?[A-Z_]+:/, '').replace(/\]$/, '');
  cv.summary = g(p, 'Summary');
  const emails = records.EMAIL_ADDRESSES ?? [];
  cv.identity.email = g(emails.find((e) => /yes|true/i.test(e.Primary ?? '')) ?? emails[0], 'Email Address');
  cv.identity.phone = g(records.PHONE_NUMBERS?.[0], 'Number');

  for (const r of records.POSITIONS ?? []) {
    const start = parsePartialDate(g(r, 'Started On'));
    const finished = g(r, 'Finished On');
    cv.experiences.push({
      id: '',
      company: g(r, 'Company Name'),
      title: g(r, 'Title'),
      location: g(r, 'Location'),
      start,
      end: finished ? parsePartialDate(finished) : start ? 'present' : '',
      contract: '',
      summary: '',
      bullets: descriptionToBullets(g(r, 'Description')).map((t) => ({ id: '', text: t })),
    });
  }
  for (const r of records.EDUCATION ?? []) {
    cv.education.push({
      id: '',
      school: g(r, 'School Name'),
      degree: g(r, 'Degree Name'),
      field: g(r, 'Field Of Study'),
      location: '',
      start: parsePartialDate(g(r, 'Start Date')),
      end: parsePartialDate(g(r, 'End Date')),
      details: [g(r, 'Notes'), g(r, 'Activities')].filter(Boolean).map((t) => ({ id: '', text: t })),
    });
  }
  const skills = (records.SKILLS ?? []).map((r) => g(r, 'Name')).filter(Boolean);
  if (skills.length) cv.skills.push({ id: '', label: '', items: skills });
  for (const r of records.LANGUAGES ?? []) cv.languages.push({ id: '', language: g(r, 'Name'), level: g(r, 'Proficiency'), certification: '' });
  for (const r of records.CERTIFICATIONS ?? []) cv.certifications.push({ id: '', name: g(r, 'Name'), issuer: g(r, 'Authority'), date: parsePartialDate(g(r, 'Started On', 'Finished On')) });
  const extra = (title: string, items: string[]) => items.length && cv.extras.push({ id: '', title, items: items.map((t) => ({ id: '', text: t })) });
  extra('Projets', (records.PROJECTS ?? []).map((r) => [g(r, 'Title'), g(r, 'Description')].filter(Boolean).join(' — ')).filter(Boolean));
  extra('Distinctions', (records.HONORS ?? []).map((r) => [g(r, 'Title'), g(r, 'Description')].filter(Boolean).join(' — ')).filter(Boolean));
  extra('Bénévolat', (records.VOLUNTEERING_EXPERIENCES ?? []).map((r) => [g(r, 'Role'), g(r, 'Company Name'), g(r, 'Description')].filter(Boolean).join(' — ')).filter(Boolean));
  return assignIds(cv);
}
