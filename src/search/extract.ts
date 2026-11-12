// Extraction des champs d'une offre à partir d'un texte brut (texte collé par
// l'utilisateur, page sans données structurées, email d'alerte). Des règles simples
// d'abord ; le modèle économique n'est sollicité que si l'intitulé ou l'entreprise manquent.
import { z } from 'zod';
import type { UserContext } from '../core/context.js';
import { getLlm, llmAvailability, UNTRUSTED_RULE, wrapUntrusted } from '../llm/index.js';
import { registerMock } from '../llm/mock.js';
import type { RawJob } from './ingest.js';

const JobFields = z.object({
  title: z.string().describe("Intitulé exact du poste, tel qu'écrit dans l'annonce. Chaîne vide si absent."),
  company: z.string().describe("Nom de l'entreprise qui recrute (pas le cabinet de recrutement si l'employeur final est nommé). Chaîne vide si absent."),
  location: z.string().describe('Lieu de travail tel qu\'écrit (ville, pays). Chaîne vide si absent.'),
  contract: z.string().describe('Type de contrat tel qu\'écrit (CDI, V.I.E, stage…). Chaîne vide si absent.'),
});

const LABELS: { key: 'title' | 'company' | 'location' | 'contract'; re: RegExp }[] = [
  { key: 'title', re: /^(?:intitul[ée] du poste|poste|job title|position|title|titre)\s*[:：]\s*(.{3,120})$/im },
  { key: 'company', re: /^(?:entreprise|soci[ée]t[ée]|company|employer|employeur|organisation|organization)\s*[:：]\s*(.{2,80})$/im },
  { key: 'location', re: /^(?:lieu|localisation|location|ville|city|office|site)\s*[:：]\s*(.{2,80})$/im },
  { key: 'contract', re: /^(?:type de contrat|contrat|contract(?: type)?|employment type)\s*[:：]\s*(.{2,40})$/im },
];

/** Champs lus par règles : libellés explicites (« Entreprise : … ») et première ligne de type « Intitulé — Entreprise ». */
export function guessJobFields(text: string): { title: string; company: string; location: string; contract: string } {
  const out = { title: '', company: '', location: '', contract: '' };
  for (const { key, re } of LABELS) {
    const m = re.exec(text);
    if (m) out[key] = m[1]!.trim();
  }
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 3) ?? '';
  if (first.length <= 140) {
    // « Senior Analyst – Acme (Paris) », « Analyst at Acme », « Analyste chez Acme »
    const at = /^(.{4,90}?)\s+(?:at|chez|@)\s+(.{2,60})$/i.exec(first);
    const dash = /^(.{4,90}?)\s+[–—|]\s+(.{2,60})$/.exec(first);
    if (at) {
      out.title ||= at[1]!.trim();
      out.company ||= at[2]!.replace(/\s*\(.*\)\s*$/, '').trim();
    } else if (dash && !out.company) {
      out.title ||= dash[1]!.trim();
      const tail = dash[2]!.trim();
      const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(tail);
      out.company = paren ? paren[1]!.trim() : tail;
      if (paren) out.location ||= paren[2]!.trim();
    } else if (!out.title && first.length <= 100 && !/[.!?]$/.test(first)) {
      out.title = first;
    }
  }
  return out;
}

const SYSTEM = `Tu extrais quatre champs d'une annonce d'emploi : intitulé du poste, entreprise qui recrute, lieu, type de contrat.
Recopie les valeurs telles qu'elles sont écrites dans l'annonce. N'invente rien : si un champ n'apparaît pas, rends une chaîne vide.
${UNTRUSTED_RULE}`;

export interface ExtractedFields {
  title: string;
  company: string;
  location: string;
  contract: string;
  method: 'rules' | 'llm';
}

/** Complète les champs manquants d'une offre collée. Sans IA disponible, seules les règles s'appliquent. */
export async function extractJobFields(ctx: UserContext, text: string, hints: { pageTitle?: string; siteName?: string } = {}): Promise<ExtractedFields> {
  const guess = guessJobFields(text);
  if (!guess.company && hints.siteName) guess.company = hints.siteName;
  if (guess.title && guess.company) return { ...guess, method: 'rules' };
  if (!(await llmAvailability(ctx)).available) return { ...guess, method: 'rules' };
  try {
    const llm = await getLlm(ctx);
    const res = await llm.json({
      purpose: 'job.extract',
      tier: 'bulk',
      system: SYSTEM,
      prompt: `${hints.pageTitle ? `Titre de la page : ${hints.pageTitle}\n` : ''}${hints.siteName ? `Site : ${hints.siteName}\n` : ''}${wrapUntrusted('offre', text.slice(0, 12_000))}`,
      schema: JobFields,
      maxTokens: 400,
      effort: 'low',
    });
    // Garde-fou : une valeur qui ne figure nulle part dans le texte fourni n'est pas retenue.
    const hay = `${text} ${hints.pageTitle ?? ''} ${hints.siteName ?? ''}`.toLowerCase();
    const grounded = (v: string) => (v && hay.includes(v.toLowerCase().slice(0, 40)) ? v.trim() : '');
    return {
      title: guess.title || grounded(res.data.title),
      company: guess.company || grounded(res.data.company),
      location: guess.location || grounded(res.data.location),
      contract: guess.contract || grounded(res.data.contract),
      method: 'llm',
    };
  } catch (err) {
    ctx.log.warn('job_extract_failed', { error: String(err) });
    return { ...guess, method: 'rules' };
  }
}

export function fieldsToRaw(fields: { title: string; company: string; location: string; contract: string }, text: string, url?: string): RawJob {
  return { url, company: fields.company, title: fields.title, location: fields.location, contractType: fields.contract, descriptionText: text };
}

registerMock('job.extract', (req) => {
  // Simulation : relit les lignes « Poste : » et « Entreprise : » du texte, sinon la première ligne.
  const body = /<donnees_non_fiables[^>]*>\n([\s\S]*)\n<\/donnees_non_fiables>/.exec(req.prompt)?.[1] ?? '';
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const find = (re: RegExp) => lines.map((l) => re.exec(l)?.[1]).find(Boolean) ?? '';
  return {
    title: find(/^(?:Poste|Job)\s*[-=]\s*(.+)$/i) || lines[0] || '',
    company: find(/^(?:Employeur final|Hiring company)\s*[-=]\s*(.+)$/i),
    location: find(/^(?:Bureau|Based in)\s*[-=]\s*(.+)$/i),
    contract: '',
  };
});
