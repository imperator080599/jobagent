import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractDateRange, parsePartialDate, samePartialDate } from '../../src/profile/dates.js';
import { parseCvHeuristic, splitList } from '../../src/profile/cv-parse.js';
import { groundingWarnings } from '../../src/profile/cv-import.js';
import { extractDocumentText, pageToText } from '../../src/profile/extract.js';
import { diffCv } from '../../src/profile/cv.js';
import { normalizeQuestion } from '../../src/profile/answers.js';
import { assignIds, cvToText } from '../../src/shared/cv.js';
import { detectLanguage, normalize, textSimilarity, tokenSimilarity } from '../../src/core/text.js';

const FIXTURE = 'tests/fixtures/cv/camille-durand';

describe('dates partielles', () => {
  it('normalise les formats usuels en français, anglais et numérique', () => {
    expect(parsePartialDate('Septembre 2021')).toBe('2021-09');
    expect(parsePartialDate('sept. 2021')).toBe('2021-09');
    expect(parsePartialDate('Feb 2020')).toBe('2020-02');
    expect(parsePartialDate('août 2019')).toBe('2019-08');
    expect(parsePartialDate('09/2021')).toBe('2021-09');
    expect(parsePartialDate('2021-09')).toBe('2021-09');
    expect(parsePartialDate('2021')).toBe('2021');
    expect(parsePartialDate("Aujourd'hui")).toBe('present');
    expect(parsePartialDate('Present')).toBe('present');
    expect(parsePartialDate('')).toBe('');
    expect(parsePartialDate('inconnu')).toBe('');
  });
  it('extrait une période et rend le reste de la ligne', () => {
    expect(extractDateRange("Paris La Défense, France | Septembre 2021 – Aujourd'hui")).toEqual({ start: '2021-09', end: 'present', rest: 'Paris La Défense, France', raw: "Septembre 2021 – Aujourd'hui" });
    expect(extractDateRange('Senior Auditor, Acme Ltd    Jan 2019 - Mar 2021')).toMatchObject({ start: '2019-01', end: '2021-03', rest: 'Senior Auditor, Acme Ltd' });
    expect(extractDateRange('2015 – 2017')).toMatchObject({ start: '2015', end: '2017' });
    expect(extractDateRange('Depuis mars 2023')).toMatchObject({ start: '2023-03', end: 'present' });
    expect(extractDateRange('01/2020 à 06/2020 — Stage')).toMatchObject({ start: '2020-01', end: '2020-06', rest: 'Stage' });
    expect(extractDateRange('Chiffre d’affaires de 150 M€ à 1,2 Md€')).toBeNull();
    expect(extractDateRange('Semi-marathon de Paris 2023')).toBeNull();
  });
  it('compare avec la précision disponible', () => {
    expect(samePartialDate('2021-09', '2021-09')).toBe(true);
    expect(samePartialDate('2021-09', '2021')).toBe(true);
    expect(samePartialDate('2021-09', '2021-10')).toBe(false);
    expect(samePartialDate('present', '2024')).toBe(false);
  });
});

describe('analyse de CV par règles', () => {
  const text = readFileSync(`${FIXTURE}.txt`, 'utf8');
  const cv = parseCvHeuristic(text);
  it('lit l’identité et les coordonnées', () => {
    expect(cv.identity).toMatchObject({
      fullName: 'Camille DURAND',
      headline: 'Auditrice financière senior — Audit légal et référentiels US GAAP',
      email: 'camille.durand@example.test',
      phone: '+33 6 00 00 00 00',
      location: 'Paris, France',
      linkedin: 'linkedin.com/in/camille-durand-exemple',
    });
  });
  it('sépare les expériences avec entreprise, intitulé, lieu, dates et puces', () => {
    expect(cv.experiences.map((e) => [e.company, e.title, e.location, e.start, e.end, e.bullets.length])).toEqual([
      ['Hartwell & Associés', 'Auditrice senior (Senior 2)', 'Paris La Défense, France', '2021-09', 'present', 5],
      ['Belmont Audit', "Auditrice junior (stage de fin d'études)", 'Lyon, France', '2021-01', '2021-06', 2],
      ['Orangina Distribution', 'Assistante contrôle de gestion (stage)', 'Marseille, France', '2019-06', '2019-12', 2],
    ]);
  });
  it('lit formation, compétences, langues et certifications', () => {
    expect(cv.education.map((e) => [e.school, e.start, e.end])).toEqual([
      ['Institut Supérieur de Gestion de Lyon', '2017', '2021'],
      ['Lycée du Parc', '2015', '2017'],
    ]);
    expect(cv.skills.find((s) => s.label === 'Outils')!.items).toEqual(['Excel avancé (TCD, RECHERCHEX)', 'PowerPoint', 'SAP', 'Alteryx (notions)']);
    expect(cv.languages.map((l) => [l.language, l.level, l.certification])).toEqual([
      ['Français', 'langue maternelle', ''],
      ['Anglais', 'courant', 'TOEIC 965'],
      ['Espagnol', 'professionnel', 'B2'],
    ]);
    expect(cv.certifications[0]).toMatchObject({ name: 'Certification AMF', issuer: 'AMF', date: '2021' });
  });
  it('n’invente rien : chaque valeur provient du texte source', () => {
    expect(groundingWarnings(cv, text)).toEqual([]);
    const tampered = structuredClone(cv);
    tampered.experiences[0]!.bullets[0]!.text = 'Direction de missions de due diligence financière pour des fonds de private equity';
    tampered.skills[0]!.items.push('Modélisation LBO');
    const w = groundingWarnings(tampered, text);
    expect(w.map((x) => x.path)).toEqual(['exp_1.b1', 'skill_1.7']);
  });
  it('attribue des identifiants stables et uniques', () => {
    const ids = [...cv.experiences.map((e) => e.id), ...cv.experiences.flatMap((e) => e.bullets.map((b) => b.id))];
    expect(new Set(ids).size).toBe(ids.length);
    expect(cv.experiences[0]!.bullets[0]!.id).toBe('exp_1.b1');
    expect(assignIds(cv).experiences[0]!.bullets[0]!.id).toBe('exp_1.b1');
  });
  it('découpe les listes sans couper les parenthèses', () => {
    expect(splitList('Excel (TCD, VBA), SAP ; Power BI | Alteryx')).toEqual(['Excel (TCD, VBA)', 'SAP', 'Power BI', 'Alteryx']);
  });
});

describe('extraction de documents', () => {
  it('lit un PDF et recolle les lignes coupées par la mise en page', async () => {
    const doc = await extractDocumentText({ filename: 'cv.pdf', mime: 'application/pdf', data: new Uint8Array(readFileSync(`${FIXTURE}.pdf`)) });
    expect(doc.kind).toBe('pdf');
    expect(doc.text).toContain('Hartwell & Associés');
    const cv = parseCvHeuristic(doc.text);
    expect(cv.experiences).toHaveLength(3);
    expect(cv.experiences[0]!.bullets).toHaveLength(5);
    expect(cv.experiences[0]!.bullets[0]!.text).toMatch(/de 150 M€ à 1,2 Md€\.$/);
  });
  it('lit un DOCX', async () => {
    const doc = await extractDocumentText({ filename: 'cv.docx', mime: '', data: new Uint8Array(readFileSync(`${FIXTURE}.docx`)) });
    expect(doc.kind).toBe('docx');
    expect(parseCvHeuristic(doc.text).experiences).toHaveLength(3);
  });
  it('refuse les formats inconnus', async () => {
    await expect(extractDocumentText({ filename: 'x.exe', mime: 'application/octet-stream', data: new Uint8Array([1, 2, 3, 4, 5, 6]) })).rejects.toThrow(/Format non pris en charge/);
  });
  it('lit les mises en page en deux colonnes colonne par colonne', () => {
    const item = (str: string, x: number, y: number) => ({ str, x, y, width: str.length * 5, fontSize: 10 });
    const items = [
      item('COMPÉTENCES', 40, 700), item('EXPÉRIENCE', 220, 700),
      item('Excel', 40, 685), item('Auditeur senior, Cabinet A', 220, 685),
      item('SAP', 40, 670), item('Revue des comptes consolidés', 220, 670),
      item('Anglais', 40, 655), item('Encadrement de juniors', 220, 655),
      item('Espagnol', 40, 640), item('Tests des contrôles internes', 220, 640),
    ];
    const text = pageToText(items);
    const lines = text.split('\n').filter(Boolean);
    expect(lines.slice(0, 5)).toEqual(['EXPÉRIENCE', 'Auditeur senior, Cabinet A', 'Revue des comptes consolidés', 'Encadrement de juniors', 'Tests des contrôles internes']);
    expect(lines.slice(5)).toEqual(['COMPÉTENCES', 'Excel', 'SAP', 'Anglais', 'Espagnol']);
  });
});

describe('comparaison de versions de CV', () => {
  it('liste ajouts, suppressions et reformulations', () => {
    const a = parseCvHeuristic(readFileSync(`${FIXTURE}.txt`, 'utf8'));
    const b = structuredClone(a);
    b.experiences[0]!.bullets[1]!.text = 'Analyse du BFR et de l’EBITDA par entité.';
    b.experiences[0]!.bullets.pop();
    b.skills[1]!.items.push('Power BI');
    b.identity.headline = 'Auditrice senior';
    const changes = diffCv(a, b);
    expect(changes).toHaveLength(4);
    expect(changes.map((c) => c.kind).sort()).toEqual(['changed', 'changed', 'changed', 'removed']);
    expect(diffCv(a, a)).toEqual([]);
  });
  it('produit un texte complet du CV', () => {
    const cv = parseCvHeuristic(readFileSync(`${FIXTURE}.txt`, 'utf8'));
    const t = cvToText(cv);
    expect(t).toContain("Auditrice senior (Senior 2) — Hartwell & Associés (Paris La Défense, France) | Septembre 2021 – Aujourd'hui");
    expect(t).toContain('Anglais : courant (TOEIC 965)');
  });
});

describe('outils de texte', () => {
  it('normalise et compare', () => {
    expect(normalize('Évaluation d’entreprise — M&A (Fusions-Acquisitions)')).toBe("evaluation d'entreprise m and a fusions acquisitions");
    expect(tokenSimilarity('Senior Associate, Transaction Services', 'Transaction Services Senior Associate')).toBe(1);
    expect(tokenSimilarity('Auditeur financier', 'Chef de projet marketing')).toBe(0);
    expect(textSimilarity('a b c d e f g h', 'a b c d e f g h')).toBe(1);
  });
  it('reconnaît la langue d’un texte', () => {
    expect(detectLanguage('Nous recherchons pour notre équipe un consultant avec une expérience dans le conseil et les transactions.')).toBe('fr');
    expect(detectLanguage('We are looking for an analyst to join our team and work with clients on the due diligence of their targets.')).toBe('en');
    expect(detectLanguage('Buscamos para nuestro equipo un analista con experiencia en el sector y que quiera crecer con la empresa.')).toBe('es');
    expect(detectLanguage('abc')).toBe('');
  });
  it('rapproche des questions formulées différemment', () => {
    expect(normalizeQuestion('Are you legally authorized to work in France? *')).toBe(normalizeQuestion('Are you legally authorized to work in France ? (required)'));
  });
});
