import { readFileSync } from 'node:fs';
import { AlignmentType, Document, Footer, Packer, Paragraph, TextRun } from 'docx';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildClassicCv } from '../../src/docs/classic-cv.js';
import { docxToPdf, documentCapabilities, pdfToPng } from '../../src/docs/convert.js';
import { alignCvTemplate, renderCv } from '../../src/docs/cv-template.js';
import { type DocxPackage, getXml, paragraphToMarked, parseParagraph, readDocx, readParagraphs, rewriteParagraph, scanParagraphs, writeDocx } from '../../src/docs/docx.js';
import { closing, formatLetterDate, salutation } from '../../src/docs/letter-conventions.js';
import { analyzeLetterTemplate, renderLetter } from '../../src/docs/letter-template.js';
import { checkRenderedDocument, measurePdf, unexpectedFonts } from '../../src/docs/qa.js';
import { parseCvHeuristic } from '../../src/profile/cv-parse.js';
import { type CvData, cvToText, emptyCv, normalizeMarkup, parseMarkup, stripMarkup } from '../../src/shared/cv.js';

const caps = await documentCapabilities();
const withOffice = caps.office && caps.poppler ? it : it.skip;

function masterCv(): CvData {
  const cv = parseCvHeuristic(readFileSync('tests/fixtures/cv/camille-durand.txt', 'utf8'));
  // Verbe d'attaque en gras, comme sur un CV réel.
  cv.experiences[0]!.bullets.forEach((b) => (b.text = b.text.replace(/^(\S+)/, '**$1**')));
  return cv;
}

/** Modèle de lettre fictif à zones entre crochets, avec consignes en italique et pied de page du fournisseur. */
async function letterTemplate(): Promise<Uint8Array> {
  const p = (text: string, o: { right?: boolean; italics?: boolean; bold?: boolean } = {}) =>
    new Paragraph({ alignment: o.right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: text ? [new TextRun({ text, font: 'Arial', size: 22, italics: o.italics, bold: o.bold })] : [] });
  const doc = new Document({
    sections: [
      {
        footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun('Modèle fourni par ExempleModeles.com — Copyright Exemple Ltd.')] })] }) },
        children: [
          new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: '[', font: 'Arial', size: 22 }), new TextRun({ text: 'Your name', font: 'Arial', size: 22, bold: true }), new TextRun({ text: ']', font: 'Arial', size: 22 })] }),
          p('[Your address]', { right: true }),
          p('[Your phone number]', { right: true }),
          p('[email address]', { right: true }),
          p('[name of the recruiter]'),
          p('[position of the recruiter]'),
          p('[name of the office]'),
          p('[address of the office]'),
          p(''),
          p('[date]', { right: true }),
          p(''),
          p('Dear Mr/Ms [name of the recruiter],'),
          p(''),
          p('[Introduction]'),
          p(''),
          p('State the purpose of your letter.', { italics: true }),
          p(''),
          p('[Why me?]'),
          p(''),
          p('State the top attributes that you bring to the role.', { italics: true }),
          p(''),
          p('[Wrap up]'),
          p(''),
          p('End with a closing statement.', { italics: true }),
          p(''),
          p('Yours sincerely,'),
          p(''),
          p('[Signature]'),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

describe('manipulation de documents Word', () => {
  it('repère les paragraphes, y compris dans les tableaux, sans descendre dans les zones de texte', () => {
    const xml = '<w:body><w:p><w:r><w:t>A</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>interne</w:t></w:r></w:p></w:txbxContent></w:pict></w:r><w:r><w:t>C</w:t></w:r></w:p><w:p/><w:pPr/></w:body>';
    const ranges = scanParagraphs(xml);
    expect(ranges).toHaveLength(4);
    expect(xml.slice(ranges[2]!.start, ranges[2]!.end)).toContain('interne');
    expect(parseParagraph(xml.slice(ranges[3]!.start, ranges[3]!.end)).text).toBe('');
  });

  it('lit le texte et la mise en valeur d’un paragraphe', () => {
    const p = parseParagraph('<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Revue</w:t></w:r><w:r><w:t xml:space="preserve"> des comptes &amp; annexes</w:t></w:r><w:r><w:tab/><w:t>2024</w:t></w:r></w:p>');
    expect(p.text).toBe('Revue des comptes & annexes\t2024');
    expect(paragraphToMarked(p)).toBe('**Revue** des comptes & annexes\t2024');
    expect(parseMarkup('**Revue** des *comptes*')).toEqual([
      { text: 'Revue', bold: true, italic: false },
      { text: ' des ', bold: false, italic: false },
      { text: 'comptes', bold: false, italic: true },
    ]);
    expect(stripMarkup('**Revue** des *comptes* 3 * 4')).toBe('Revue des comptes 3 * 4');
  });

  it('réécrit un paragraphe en conservant son style, ses polices et sa puce', () => {
    const base = parseParagraph(
      '<w:p w:rsidR="00A1"><w:pPr><w:ind w:left="400" w:hanging="360"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>•</w:t></w:r><w:r><w:tab/></w:r><w:r><w:rPr><w:rFonts w:ascii="Calibri"/><w:b/><w:sz w:val="20"/></w:rPr><w:t>Audit</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve"> des comptes</w:t></w:r></w:p>',
    );
    const out = rewriteParagraph(base, '**Revue** des cycles & <stocks>', { keepPrefix: 2 });
    expect(out.startsWith('<w:p w:rsidR="00A1"><w:pPr><w:ind w:left="400" w:hanging="360"/></w:pPr>')).toBe(true);
    expect(out).toContain('<w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>•</w:t></w:r><w:r><w:tab/></w:r>');
    expect(out).toContain('<w:rPr><w:rFonts w:ascii="Calibri"/><w:b/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">Revue</w:t>');
    expect(out).toContain('des cycles &amp; &lt;stocks&gt;');
    expect(parseParagraph(out).text).toBe('•\tRevue des cycles & <stocks>');
  });

  it('applique la mise en forme dominante quand le nouveau texte n’est pas balisé', () => {
    const bold = parseParagraph('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Accroche entièrement en gras</w:t></w:r></w:p>');
    expect(rewriteParagraph(bold, 'Nouvelle accroche')).toBe('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Nouvelle accroche</w:t></w:r></w:p>');
    // Gras demandé sur un paragraphe qui n'en contenait pas : dérivé de la police d'origine.
    const plain = parseParagraph('<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="20"/></w:rPr><w:t>Texte</w:t></w:r></w:p>');
    expect(rewriteParagraph(plain, '**Gras** normal')).toContain('<w:rPr><w:rFonts w:ascii="Calibri"/><w:b/><w:bCs/><w:sz w:val="20"/></w:rPr>');
  });
});

describe('template de CV', () => {
  let master: CvData;
  let pkg: DocxPackage;
  beforeAll(async () => {
    master = masterCv();
    pkg = readDocx(await buildClassicCv(master));
  });

  it('rattache chaque élément du CV master à son paragraphe', () => {
    const profile = alignCvTemplate(pkg, master);
    expect(profile.unmatched).toEqual([]);
    expect(Object.keys(profile.headings).sort()).toEqual(['certifications', 'education', 'experiences', 'extra:extra_1', 'languages', 'skills']);
    const { paragraphs } = readParagraphs(getXml(pkg));
    expect(paragraphs[profile.elements['exp_1.b2']![0]!]!.text).toContain("Revue des cycles chiffre d'affaires");
    expect(profile.elements.exp_1).toHaveLength(2);
    expect(paragraphs[profile.elements.exp_1![0]!]!.text).toBe('Hartwell & Associés\tParis La Défense, France');
  });

  it('ne modifie rien quand le CV est inchangé', () => {
    const profile = alignCvTemplate(pkg, master);
    const r = renderCv(pkg, profile, master, structuredClone(master));
    expect(r.changes).toBe(0);
    expect(getXml(r.pkg)).toBe(getXml(pkg));
  });

  it('personnalise en ne touchant que les paragraphes concernés', () => {
    const profile = alignCvTemplate(pkg, master);
    const t = structuredClone(master);
    const b = t.experiences[0]!.bullets;
    t.summary = 'Auditrice financière senior visant un poste en due diligence financière.';
    t.experiences[0]!.bullets = [b[1]!, { ...b[0]!, text: 'Audit de filiales françaises de groupes américains cotés (US GAAP, PCAOB).' }, b[4]!];
    t.experiences[2]!.bullets = [];
    t.skills[1]!.items = ['SAP', 'Excel avancé (TCD, RECHERCHEX)'];
    t.extras = [];
    const r = renderCv(pkg, profile, master, t);
    expect(r.problems).toEqual([]);
    const before = readParagraphs(getXml(pkg)).paragraphs;
    const after = readParagraphs(getXml(r.pkg)).paragraphs;
    const texts = after.map((p) => p.text);

    // En-tête et lignes d'entreprise : identiques à l'octet près.
    for (const id of ['identity.name', 'exp_1', 'exp_2', 'edu_1']) for (const i of profile.elements[id]!) expect(after.some((p) => p.xml === before[i]!.xml)).toBe(true);
    // Puces réordonnées, reformulées et retirées.
    const exp1 = texts.indexOf('Hartwell & Associés\tParis La Défense, France');
    expect(texts.slice(exp1 + 2, exp1 + 6)).toEqual([
      "•\tRevue des cycles chiffre d'affaires, stocks et provisions ; analyse des variations de BFR et de l'EBITDA par entité.",
      '•\tAudit de filiales françaises de groupes américains cotés (US GAAP, PCAOB).',
      "•\tPréparation des synthèses d'audit et présentation aux associés et aux directeurs financiers des clients.",
      'Belmont Audit\tLyon, France',
    ]);
    // La puce reformulée reprend la forme de la puce d'origine : même style de paragraphe, verbe d'attaque en gras.
    const reworded = after.find((p) => p.text.includes('Audit de filiales'))!;
    expect(reworded.pPr).toBe(before[profile.elements['exp_1.b1']![0]!]!.pPr);
    expect(paragraphToMarked(reworded)).toBe('•\t**Audit** de filiales françaises de groupes américains cotés (US GAAP, PCAOB).');
    // Accroche réécrite dans sa mise en forme d'origine (gras).
    expect(after.find((p) => p.text.startsWith('Auditrice financière senior visant'))!.runs.every((x) => x.bold)).toBe(true);
    // Ligne de compétences : libellé et ponctuation conservés.
    expect(texts).toContain('•\tOutils : SAP, Excel avancé (TCD, RECHERCHEX)');
    // Rubrique retirée avec son titre ; expérience vidée de ses puces mais conservée.
    expect(texts.join('\n')).not.toMatch(/CENTRES D'INTÉRÊT|Trail et course/);
    expect(texts).toContain('Orangina Distribution\tMarseille, France');
    expect(texts.join('\n')).not.toContain('Suivi mensuel des marges');
    // Le template d'origine n'est pas altéré.
    expect(readParagraphs(getXml(pkg)).paragraphs.length).toBe(before.length);
  });

  it('signale une modification impossible à reporter au lieu de l’ignorer', () => {
    const other = structuredClone(master);
    other.summary = '';
    const profile = alignCvTemplate(readDocx(writeDocx(pkg)), master);
    delete profile.elements.summary;
    const t = structuredClone(master);
    t.summary = 'Nouvelle accroche';
    expect(renderCv(pkg, profile, master, t).problems[0]).toMatch(/Accroche : emplacement introuvable/);
  });
});

describe('template de lettre', () => {
  let pkg: DocxPackage;
  beforeAll(async () => {
    pkg = readDocx(await letterTemplate());
  });
  const content = {
    sender: { name: 'Camille Durand', phone: '+33 6 00 00 00 00', email: 'camille.durand@example.test' },
    recipient: { company: 'Cabinet Valmont' },
    date: '11 November 2026',
    salutation: 'Dear Hiring Manager,',
    sections: { introduction: ['First paragraph.'], 'why-me': ['Second paragraph.', 'Third paragraph.'], 'wrap-up': ['Closing paragraph.'] },
    closing: 'Yours faithfully,',
    signature: 'Camille Durand',
  };

  it('reconnaît les zones, les consignes et les mentions du fournisseur', () => {
    const profile = analyzeLetterTemplate(pkg);
    expect(profile.language).toBe('en');
    expect(profile.sections).toEqual([
      { key: 'introduction', label: 'Introduction', brief: 'State the purpose of your letter.' },
      { key: 'why-me', label: 'Why me', brief: 'State the top attributes that you bring to the role.' },
      { key: 'wrap-up', label: 'Wrap up', brief: 'End with a closing statement.' },
    ]);
    expect(profile.paragraphs.filter((p) => p.role === 'field').map((p) => p.field)).toEqual([
      'sender.name', 'sender.address', 'sender.phone', 'sender.email', 'recipient.name', 'recipient.title', 'recipient.company', 'recipient.address', 'date', 'signature',
    ]);
    expect(profile.closingText).toBe('Yours sincerely,');
    expect(profile.vendorFooters).toHaveLength(1);
    expect(profile.unknownPlaceholders).toEqual([]);
  });

  it('remplit une copie du template sans rien laisser entre crochets ni rien inventer', () => {
    const profile = analyzeLetterTemplate(pkg);
    const out = renderLetter(pkg, profile, content);
    const paras = readParagraphs(getXml(out)).paragraphs;
    const texts = paras.map((p) => p.text);
    expect(texts).toEqual([
      'Camille Durand', '+33 6 00 00 00 00', 'camille.durand@example.test', 'Cabinet Valmont', '', '11 November 2026', '', 'Dear Hiring Manager,', '',
      'First paragraph.', '', 'Second paragraph.', '', 'Third paragraph.', '', 'Closing paragraph.', '', 'Yours faithfully,', '', 'Camille Durand',
    ]);
    // Le nom garde le gras et l'alignement à droite du template.
    expect(paras[0]!.runs.every((r) => r.bold)).toBe(true);
    expect(paras[0]!.pPr).toContain('w:val="right"');
    expect(paras[9]!.runs[0]!.rPr).toContain('Arial');
    // Mention du fournisseur retirée du pied de page ; template d'origine intact.
    const footer = Object.keys(out.files).find((f) => /^word\/footer\d*\.xml$/.test(f))!;
    expect(Buffer.from(out.files[footer]!).toString()).not.toContain('Copyright');
    expect(Buffer.from(pkg.files[footer]!).toString()).toContain('Copyright');
    expect(getXml(pkg)).toContain('[Introduction]');
  });
});

describe('usages épistolaires', () => {
  it('adapte formules et dates à la langue et au pays', () => {
    const d = new Date('2026-11-01T00:00:00Z');
    expect(formatLetterDate(d, 'fr', 'FR', 'Paris')).toBe('Paris, le 1er novembre 2026');
    expect(formatLetterDate(d, 'en', 'GB')).toBe('1 November 2026');
    expect(formatLetterDate(d, 'en', 'US')).toBe('November 1, 2026');
    expect(formatLetterDate(d, 'es')).toBe('1 de noviembre de 2026');
    expect(formatLetterDate(d, 'de')).toBe('1. November 2026');
    // Sans destinataire connu : formule neutre. La civilité n'est jamais devinée d'après un prénom.
    expect(salutation('en')).toBe('Dear Hiring Manager,');
    expect(salutation('en', { name: 'Alex Morgan' })).toBe('Dear Alex Morgan,');
    expect(salutation('en', { name: 'Alex Morgan', civility: 'ms' })).toBe('Dear Ms Morgan,');
    expect(salutation('fr', { name: 'Claude Martin' })).toBe('Madame, Monsieur,');
    expect(salutation('fr', { name: 'Claude Martin', civility: 'mr' })).toBe('Monsieur Martin,');
    expect(closing('en', 'GB', true)).toBe('Yours sincerely,');
    expect(closing('en', 'GB', false)).toBe('Yours faithfully,');
    expect(closing('en', 'US')).toBe('Sincerely,');
    expect(closing('fr')).toMatch(/salutations distinguées/);
  });
});

describe('rendu PDF et contrôle qualité', () => {
  withOffice('convertit un CV en PDF fidèle et le contrôle', async () => {
    const master = masterCv();
    const docx = await buildClassicCv(master);
    const pkg = readDocx(docx);
    const profile = alignCvTemplate(pkg, master);
    const baselinePdf = await docxToPdf(docx);
    const baseline = await measurePdf(baselinePdf);
    expect(baseline.pages).toBe(1);
    expect(baseline.bodyFontSize).toBe(10);

    const t = structuredClone(master);
    t.experiences[0]!.bullets.reverse();
    const pdf = await docxToPdf(writeDocx(renderCv(pkg, profile, master, t).pkg));
    const expected = [t.identity.fullName, ...t.experiences.flatMap((e) => [e.company, e.title, ...e.bullets.map((b) => stripMarkup(b.text))])];
    const qa = await checkRenderedDocument({ pdf, expectedTexts: expected, maxPages: 1, templateFonts: profile.fonts, baseline, page: profile.page });
    expect(qa.checks.filter((c) => !c.ok)).toEqual([]);
    expect(qa.ok).toBe(true);
    expect((await pdfToPng(pdf, { dpi: 40 }))[0]!.byteLength).toBeGreaterThan(2000);
  }, 120_000);

  withOffice('détecte un débordement de page et un contenu manquant', async () => {
    const master = masterCv();
    const long = structuredClone(master);
    for (let i = 0; i < 45; i++) long.experiences[0]!.bullets.push({ id: '', text: `Mission supplémentaire numéro ${i + 1} décrite sur une ligne complète du document pour le remplir.` });
    const pdf = await docxToPdf(await buildClassicCv(long));
    const qa = await checkRenderedDocument({ pdf, expectedTexts: ['Ce texte ne figure nulle part dans le document'], maxPages: 1 });
    expect(qa.ok).toBe(false);
    expect(qa.checks.find((c) => c.id === 'pages')).toMatchObject({ ok: false, message: 'Le document occupe 2 pages au lieu de 1.' });
    expect(qa.checks.find((c) => c.id === 'content')!.ok).toBe(false);
  }, 120_000);

  it('distingue les polices de substitution admises des polices inattendues', () => {
    expect(unexpectedFonts(['BAAAAA+Carlito', 'Carlito-Bold', 'LiberationSans'], ['Calibri', 'Arial'])).toEqual([]);
    expect(unexpectedFonts(['DejaVuSans', 'Carlito'], ['Calibri'])).toEqual(['DejaVuSans']);
  });
});

describe('mise en valeur balisée', () => {
  it('fusionne les passages contigus et retire les balises orphelines', async () => {
    const { normalizeMarkup } = await import('../../src/shared/cv.js');
    expect(normalizeMarkup('***a highly selective*** ***two-year program***')).toBe('***a highly selective two-year program***');
    expect(normalizeMarkup('**Revue** **des comptes** annuels')).toBe('**Revue des comptes** annuels');
    expect(normalizeMarkup('**Titre:** *a highly selective post-*secondary program')).toBe('**Titre:** *a highly selective post-secondary* program');
    expect(normalizeMarkup('**Audit des comptes')).toBe('Audit des comptes');
    // Un astérisque arithmétique n'est pas une balise.
    expect(normalizeMarkup('Marge de 3 * 4 points')).toBe('Marge de 3 * 4 points');
    expect(normalizeMarkup('**Identified** two overstatements')).toBe('**Identified** two overstatements');
  });

  it('balise le gras partiel d’une ligne de PDF et restitue les espaces exacts', async () => {
    const { pageToText } = await import('../../src/profile/extract.js');
    const it = (str: string, x: number, width: number, bold = false) => ({ str, x, y: 700, width, fontSize: 10, bold });
    // Fragments tels qu'un PDF Word les expose : espaces explicites, tabulation rendue par un large blanc.
    const line = [it('•', 52, 4), it(' ', 56, 14), it('Identified', 70, 44, true), it(' ', 114, 1.8), it('two', 116, 14), it(' ', 130, 1.7), it('overstatements', 131.7, 60)];
    expect(pageToText(line, { markup: true })).toBe('• **Identified** two overstatements');
    expect(pageToText(line)).toBe('• Identified two overstatements');
    const header = [it('Mazars France', 50, 70, true), it(' ', 120, 350), it('Paris,', 470, 26), it(' ', 496, 1.7), it('France', 497.7, 30)];
    expect(pageToText(header, { markup: true })).toBe('**Mazars France**    Paris, France');
    // Ligne entièrement en gras : aucune balise (la mise en forme est celle du paragraphe).
    expect(pageToText([it('EDUCATION', 277, 50, true)], { markup: true })).toBe('EDUCATION');
  });
});

describe('texte brut du CV', () => {
  it('ne laisse aucun astérisque, même quand une mise en valeur s’arrête au milieu d’un mot', () => {
    expect(stripMarkup('*a highly selective post-*secondary programme')).toBe('a highly selective post-secondary programme');
    expect(stripMarkup('**Reviewed** DCF tests and *italic* words')).toBe('Reviewed DCF tests and italic words');
    expect(stripMarkup('Marge 5 * 3 = 15')).toBe('Marge 5 * 3 = 15');
    // À l'écriture d'un document, l'italique coupé au milieu d'un mot est étendu au mot entier (aucun astérisque littéral).
    const spans = parseMarkup(normalizeMarkup('**Track:** *a highly selective post-*secondary programme'));
    expect(spans.map((x) => [x.text, x.bold, x.italic])).toEqual([['Track:', true, false], [' ', false, false], ['a highly selective post-secondary', false, true], [' programme', false, false]]);
    expect(parseMarkup(normalizeMarkup('pre*fix word* suite')).map((x) => x.text).join('')).toBe('prefix word suite');
  });

  it('n’ajoute aucun titre absent du document d’origine et emploie la langue du CV', () => {
    const cv = emptyCv('en');
    cv.identity.fullName = 'Camille Durand';
    cv.summary = 'Senior auditor moving to transaction services.';
    cv.experiences = [{ id: 'exp_1', company: 'Hartwell', title: 'Senior Auditor', location: '', start: '', end: '', dates: '2021 – Present', contract: '', summary: '', bullets: [{ id: 'exp_1.b1', text: '**Reviewed** revenue contracts.' }] }];
    const text = cvToText(cv);
    expect(text).not.toContain('PROFIL');
    expect(text).toContain('Camille Durand\n\nSenior auditor moving to transaction services.\n\nWORK EXPERIENCE');
    expect(text).not.toContain('*');
    cv.titles = { summary: 'PROFILE', experiences: 'CAREER HISTORY' };
    expect(cvToText(cv)).toContain('PROFILE\nSenior auditor');
    expect(cvToText(cv)).toContain('CAREER HISTORY');
  });
});
