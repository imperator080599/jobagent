// Template de CV : le document Word de référence est le template. Chaque élément du
// CV master (accroche, puce, ligne de compétences…) est rattaché à son paragraphe
// dans ce document. Un CV personnalisé est une copie du document dans laquelle
// seuls les paragraphes concernés sont réécrits, retirés ou réordonnés : la mise en
// page, les polices, les tabulations, les filets et l'en-tête restent ceux de l'original.
import { coverage, normalize, tokenSimilarity, tokens } from '../core/text.js';
import { type Bullet, type CvData, stripMarkup } from '../shared/cv.js';
import { type DocxPackage, type DocxParagraph, type Edit, applyEdits, declaredFonts, getXml, pageGeometry, paragraphToMarked, readParagraphs, rewriteParagraph, setXml } from './docx.js';

export interface CvTemplateProfile {
  kind: 'cv';
  /** Identifiant d'élément du master → paragraphes du document. */
  elements: Record<string, number[]>;
  /** Rubrique → paragraphe de son titre. */
  headings: Record<string, number>;
  /** Éléments du master introuvables dans le document (le template et le master ne correspondent pas). */
  unmatched: string[];
  paragraphCount: number;
  fonts: string[];
  page: ReturnType<typeof pageGeometry>;
}

const BULLET_PREFIX = /^\s*[•◦▪■●○·‣∙➢►▸–-]\s*\t?\s*/;
const clean = (text: string) => normalize(stripMarkup(text).replace(BULLET_PREFIX, ''));
const same = (a: string, b: string) => clean(a) === clean(b);

/** Rattache les éléments du CV master aux paragraphes du document, dans l'ordre de lecture. */
export function alignCvTemplate(pkg: DocxPackage, master: CvData): CvTemplateProfile {
  const xml = getXml(pkg);
  const { paragraphs } = readParagraphs(xml);
  const texts = paragraphs.map((p) => clean(p.text));
  const tokenSets = texts.map((t) => new Set(tokens(t)));
  const elements: Record<string, number[]> = {};
  const headings: Record<string, number> = {};
  const unmatched: string[] = [];
  const taken = new Set<number>();
  let pos = -1;

  const find = (pred: (i: number) => boolean, opts: { from?: number; window?: number } = {}): number => {
    const start = (opts.from ?? pos) + 1;
    const end = Math.min(paragraphs.length, start + (opts.window ?? 80));
    for (let i = start; i < end; i++) if (!taken.has(i) && texts[i] && pred(i)) return i;
    return -1;
  };
  const assign = (id: string, idx: number[], advance = true) => {
    const found = idx.filter((i) => i >= 0);
    if (!found.length) {
      unmatched.push(id);
      return;
    }
    elements[id] = found;
    for (const i of found) taken.add(i);
    if (advance) pos = Math.max(pos, ...found);
  };
  const exact = (text: string) => {
    const c = clean(text);
    return c ? find((i) => texts[i] === c) : -1;
  };
  const near = (text: string, min = 0.9) => {
    const c = clean(text);
    if (!c) return -1;
    const e = exact(text);
    if (e >= 0) return e;
    return find((i) => tokenSimilarity(texts[i]!, c) >= min);
  };
  const containing = (text: string, min = 1) => {
    const t = clean(text);
    return t ? find((i) => coverage(t, tokenSets[i]!) >= min) : -1;
  };
  const heading = (key: string, title: string | undefined) => {
    if (!title) return;
    const c = clean(title);
    const i = find((k) => texts[k] === c, { from: pos, window: 12 });
    if (i >= 0) {
      headings[key] = i;
      taken.add(i);
      pos = i;
    }
  };
  const items = (list: Bullet[]) => {
    for (const b of list) assign(b.id, [near(b.text)]);
  };

  // En-tête
  if (master.identity.fullName) assign('identity.name', [find((i) => texts[i] === clean(master.identity.fullName), { from: -1, window: 8 })]);
  if (master.identity.headline) {
    const whole = clean(master.identity.headline);
    const one = find((i) => texts[i] === whole, { window: 10 });
    if (one >= 0) assign('identity.headline', [one]);
    else {
      // Accroche répartie sur plusieurs paragraphes consécutifs.
      const parts: number[] = [];
      let rest = whole;
      for (let i = pos + 1; i < Math.min(paragraphs.length, pos + 10) && rest; i++) {
        const t = texts[i]!;
        if (t && rest.startsWith(t)) {
          parts.push(i);
          rest = rest.slice(t.length).trim();
        } else if (parts.length) break;
      }
      assign('identity.headline', rest === '' ? parts : []);
    }
  }
  if (master.summary) assign('summary', [near(master.summary, 0.85)]);

  for (const section of master.sectionOrder) {
    if (section === 'experiences') {
      heading('experiences', master.titles?.experiences);
      for (const e of master.experiences) {
        const h1 = containing(e.company);
        const h2 = e.title ? find((i) => i !== h1 && coverage(clean(e.title), tokenSets[i]!) >= 0.9, { from: h1 >= 0 ? h1 - 1 : pos, window: 4 }) : -1;
        assign(e.id, h1 >= 0 && coverage(clean(e.title), tokenSets[h1]!) >= 0.9 ? [h1] : [h1, h2]);
        if (e.summary) assign(`${e.id}.summary`, [near(e.summary)]);
        items(e.bullets);
      }
    }
    if (section === 'education') {
      heading('education', master.titles?.education);
      for (const e of master.education) {
        const h1 = containing(e.school);
        const degree = [e.degree, e.field].filter(Boolean).join(' ');
        const inH1 = h1 >= 0 && degree && coverage(clean(degree), tokenSets[h1]!) >= 0.9;
        const h2 = degree && !inH1 ? find((i) => i !== h1 && coverage(clean(degree), tokenSets[i]!) >= 0.9, { from: h1 >= 0 ? h1 - 2 : pos, window: 5 }) : -1;
        assign(e.id, [h1, h2]);
        items(e.details);
      }
    }
    if (section === 'skills') {
      heading('skills', master.titles?.skills);
      for (const g of master.skills) assign(g.id, [find((i) => coverage(clean(g.items.join(' ')), tokenSets[i]!) >= 0.8 && (!g.label || coverage(clean(g.label), tokenSets[i]!) >= 0.99))]);
    }
    if (section === 'languages') {
      heading('languages', master.titles?.languages);
      for (const l of master.languages) {
        const i = find((k) => coverage(clean(l.language), tokenSets[k]!) >= 0.99, { window: 12 });
        // Plusieurs langues peuvent partager une même ligne : le paragraphe n'est alors pas réservé.
        if (i >= 0) elements[l.id] = [i];
        else unmatched.push(l.id);
      }
      for (const i of new Set(master.languages.flatMap((l) => elements[l.id] ?? []))) {
        taken.add(i);
        pos = Math.max(pos, i);
      }
    }
    if (section === 'certifications') {
      heading('certifications', master.titles?.certifications);
      for (const c of master.certifications) assign(c.id, [containing(c.name, 0.9)]);
    }
    if (section === 'extras') {
      for (const x of master.extras) {
        heading(`extra:${x.id}`, x.title);
        items(x.items);
      }
    }
  }

  // Titre de rubrique non reconnu par son libellé : c'est le court paragraphe libre qui précède le premier élément de la rubrique.
  const firstOf: Record<string, string | undefined> = {
    experiences: master.experiences[0]?.id,
    education: master.education[0]?.id,
    skills: master.skills[0]?.id,
    languages: master.languages[0]?.id,
    certifications: master.certifications[0]?.id,
  };
  for (const x of master.extras) firstOf[`extra:${x.id}`] = x.items[0]?.id;
  for (const [key, id] of Object.entries(firstOf)) {
    if (headings[key] !== undefined || !id) continue;
    const first = elements[id]?.[0];
    if (first === undefined) continue;
    for (let i = first - 1; i >= Math.max(0, first - 3); i--) {
      if (taken.has(i)) break;
      if (texts[i] && texts[i]!.length < 60) {
        headings[key] = i;
        taken.add(i);
        break;
      }
    }
  }
  return { kind: 'cv', elements, headings, unmatched, paragraphCount: paragraphs.length, fonts: declaredFonts(pkg), page: pageGeometry(xml) };
}

export interface CvRenderResult {
  pkg: DocxPackage;
  /** Modifications demandées qui n'ont pas pu être reportées dans le document. */
  problems: string[];
  /** Nombre de paragraphes réécrits, retirés ou déplacés. */
  changes: number;
}

/** Texte à écrire pour un élément : reprend le gras d'attaque du master si la nouvelle rédaction n'en porte pas. */
function withLeadIn(text: string, masterMarked: string | undefined): string {
  if (!masterMarked || /\*/.test(text)) return text;
  const lead = /^\*\*(.+?)\*\*/.exec(masterMarked.replace(BULLET_PREFIX, ''));
  if (!lead) return text;
  // Même nombre de mots en gras que dans l'élément d'origine (au plus trois).
  const n = Math.min(lead[1]!.trim().split(/\s+/).length, 3);
  const m = new RegExp(`^(\\S+(?:\\s+\\S+){0,${n - 1}})(\\s[\\s\\S]*)?$`).exec(text.trim());
  return m ? `**${m[1]}**${m[2] ?? ''}` : text;
}

/**
 * Produit le CV personnalisé à partir d'une copie du template.
 * `master` est le CV sur lequel le template a été aligné ; `tailored` reprend ses
 * identifiants (éléments conservés, reformulés, réordonnés ou retirés).
 */
export function renderCv(template: DocxPackage, profile: CvTemplateProfile, master: CvData, tailored: CvData): CvRenderResult {
  const pkg: DocxPackage = { files: { ...template.files } };
  const xml = getXml(pkg);
  const doc = readParagraphs(xml);
  if (doc.paragraphs.length !== profile.paragraphCount) throw new Error('Le template a changé depuis son analyse : relancez son alignement avec le CV master.');
  const edits: Edit[] = [];
  const problems: string[] = [];
  const touched = new Set<number>();
  const para = (i: number): DocxParagraph => doc.paragraphs[i]!;
  const prefixOf = (p: DocxParagraph) => BULLET_PREFIX.exec(p.text)?.[0].length ?? 0;
  const rewritten = (i: number, text: string) => rewriteParagraph(para(i), text, { keepPrefix: prefixOf(para(i)) });
  const remove = (i: number) => {
    if (touched.has(i)) return;
    touched.add(i);
    edits.push({ ...doc.ranges[i]!, replacement: '' });
  };
  const replace = (i: number, replacement: string) => {
    if (touched.has(i)) return;
    touched.add(i);
    edits.push({ ...doc.ranges[i]!, replacement });
  };

  // Champ simple (accroche, résumé) : réécrit seulement s'il a changé.
  const simple = (id: string, before: string, after: string, label: string) => {
    if (same(before, after)) return;
    const idx = profile.elements[id];
    if (!idx?.length) {
      if (after.trim()) problems.push(`${label} : emplacement introuvable dans le template, modification non reportée.`);
      return;
    }
    if (!after.trim()) return idx.forEach(remove);
    replace(idx[0]!, rewritten(idx[0]!, after));
    idx.slice(1).forEach(remove);
  };
  simple('identity.headline', master.identity.headline ?? '', tailored.identity.headline ?? '', 'Titre');
  simple('summary', master.summary ?? '', tailored.summary ?? '', 'Accroche');

  /** Liste d'éléments (puces) : conserve, reformule, réordonne ou retire, en reprenant la forme de chaque paragraphe d'origine. */
  const list = (before: Bullet[], after: Bullet[], label: string) => {
    const masterById = new Map(before.map((b) => [b.id, b]));
    const unchanged = before.length === after.length && before.every((b, k) => after[k]!.id === b.id && same(b.text, after[k]!.text));
    if (unchanged) return;
    const idx = before.map((b) => profile.elements[b.id]?.[0]).filter((i): i is number => i !== undefined);
    if (!idx.length) {
      if (after.length) problems.push(`${label} : éléments introuvables dans le template, modifications non reportées.`);
      return;
    }
    const proto = idx[0]!;
    const build = (item: Bullet): string => {
      const src = profile.elements[item.id]?.[0];
      const m = masterById.get(item.id);
      if (src !== undefined && m && same(m.text, item.text)) return para(src).xml;
      const base = src ?? proto;
      const masterMarked = src !== undefined ? paragraphToMarked(para(src)) : paragraphToMarked(para(proto));
      return rewritten(base, withLeadIn(item.text, masterMarked));
    };
    const contiguous = idx.length === before.length && idx.every((v, k) => k === 0 || v === idx[k - 1]! + 1);
    if (contiguous) {
      // Le bloc de puces est remplacé d'un seul tenant, dans le nouvel ordre.
      idx.forEach((i) => touched.add(i));
      edits.push({ start: doc.ranges[idx[0]!]!.start, end: doc.ranges[idx[idx.length - 1]!]!.end, replacement: after.map(build).join('') });
      return;
    }
    // Paragraphes non consécutifs : modifications sur place, sans réordonnancement.
    const kept = new Map(after.map((a) => [a.id, a]));
    for (const b of before) {
      const i = profile.elements[b.id]?.[0];
      if (i === undefined) continue;
      const a = kept.get(b.id);
      if (!a) remove(i);
      else if (!same(a.text, b.text)) replace(i, build(a));
    }
    if (after.some((a) => !masterById.has(a.id))) problems.push(`${label} : un élément ajouté n'a pas pu être inséré (mise en page non linéaire).`);
  };

  const dropSection = (key: string) => {
    const h = profile.headings[key];
    if (h !== undefined) remove(h);
  };

  // Expériences
  const tExp = new Map(tailored.experiences.map((e) => [e.id, e]));
  for (const e of master.experiences) {
    const t = tExp.get(e.id);
    if (!t) {
      (profile.elements[e.id] ?? []).forEach(remove);
      (profile.elements[`${e.id}.summary`] ?? []).forEach(remove);
      e.bullets.forEach((b) => (profile.elements[b.id] ?? []).forEach(remove));
      continue;
    }
    if (e.summary || t.summary) simple(`${e.id}.summary`, e.summary ?? '', t.summary ?? '', `${e.company} (description)`);
    list(e.bullets, t.bullets, e.company);
  }
  if (master.experiences.length && !tailored.experiences.length) dropSection('experiences');

  // Formation
  const tEdu = new Map(tailored.education.map((e) => [e.id, e]));
  for (const e of master.education) {
    const t = tEdu.get(e.id);
    if (!t) {
      (profile.elements[e.id] ?? []).forEach(remove);
      e.details.forEach((b) => (profile.elements[b.id] ?? []).forEach(remove));
      continue;
    }
    list(e.details, t.details, e.school);
  }
  if (master.education.length && !tailored.education.length) dropSection('education');

  // Compétences : la ligne garde son libellé et sa ponctuation d'origine, seuls les éléments changent.
  const tSkills = new Map(tailored.skills.map((g) => [g.id, g]));
  for (const g of master.skills) {
    const t = tSkills.get(g.id);
    const i = profile.elements[g.id]?.[0];
    if (!t) {
      if (i !== undefined) remove(i);
      continue;
    }
    if (g.items.join('|') === t.items.join('|')) continue;
    if (i === undefined) {
      problems.push(`Compétences « ${g.label} » : ligne introuvable dans le template.`);
      continue;
    }
    const marked = paragraphToMarked(para(i)).slice(prefixOf(para(i)));
    const first = g.items[0] ? marked.indexOf(g.items[0]) : -1;
    const second = g.items[1] ? marked.indexOf(g.items[1], first + (g.items[0]?.length ?? 0)) : -1;
    const sep = first >= 0 && second > first ? marked.slice(first + g.items[0]!.length, second) : ', ';
    const last = g.items[g.items.length - 1];
    const tailEnd = last ? marked.lastIndexOf(last) + last.length : marked.length;
    const prefix = first >= 0 ? marked.slice(0, first) : g.label ? `**${g.label}** : ` : '';
    replace(i, rewritten(i, `${prefix}${t.items.join(sep)}${first >= 0 ? marked.slice(tailEnd) : ''}`));
  }
  if (master.skills.length && !tailored.skills.length) dropSection('skills');

  // Langues et certifications : retrait uniquement (leur contenu ne se reformule pas).
  const tLang = new Set(tailored.languages.map((l) => l.id));
  const langParas = new Map<number, string[]>();
  for (const l of master.languages) for (const i of profile.elements[l.id] ?? []) langParas.set(i, [...(langParas.get(i) ?? []), l.id]);
  for (const [i, ids] of langParas) if (ids.every((id) => !tLang.has(id))) remove(i);
  const tCert = new Set(tailored.certifications.map((c) => c.id));
  for (const c of master.certifications) if (!tCert.has(c.id)) (profile.elements[c.id] ?? []).forEach(remove);
  if (master.certifications.length && !tailored.certifications.length) dropSection('certifications');
  if (master.languages.length && !tailored.languages.length) dropSection('languages');

  // Autres rubriques
  const tExtras = new Map(tailored.extras.map((x) => [x.id, x]));
  for (const x of master.extras) {
    const t = tExtras.get(x.id);
    if (!t || !t.items.length) {
      dropSection(`extra:${x.id}`);
      x.items.forEach((b) => (profile.elements[b.id] ?? []).forEach(remove));
      continue;
    }
    list(x.items, t.items, x.title);
  }

  setXml(pkg, applyEdits(xml, edits));
  return { pkg, problems, changes: edits.length };
}
