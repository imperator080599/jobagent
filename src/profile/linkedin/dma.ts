// API officielle LinkedIn « Member Data Portability » (Member Snapshot API),
// ouverte aux membres de l'UE/EEE et de Suisse pour leurs propres données.
// Documentation : learn.microsoft.com/linkedin/dma/member-data-portability
// Aucune session navigateur, aucun contournement : un jeton d'accès émis par
// LinkedIn pour le membre, stocké chiffré.
import type { AppContext } from '../../core/context.js';
import { ConfigError } from '../../core/errors.js';
import type { LinkedinRecords } from './records.js';

const ENDPOINT = 'https://api.linkedin.com/rest/memberSnapshotData';
/** Seule version acceptée par ce point d'accès selon la documentation. */
const API_VERSION = '202312';
export const PROFILE_DOMAINS = ['PROFILE', 'POSITIONS', 'EDUCATION', 'SKILLS', 'LANGUAGES', 'CERTIFICATIONS', 'PROJECTS', 'HONORS', 'COURSES', 'VOLUNTEERING_EXPERIENCES', 'EMAIL_ADDRESSES', 'PHONE_NUMBERS'];

export async function fetchDmaSnapshot(ctx: Pick<AppContext, 'fetch' | 'log'>, accessToken: string, domains = PROFILE_DOMAINS): Promise<LinkedinRecords> {
  const out: LinkedinRecords = {};
  for (const domain of domains) {
    const rows: Record<string, string>[] = [];
    // La documentation demande de paginer jusqu'à l'erreur « No data found » : le total annoncé n'est pas fiable.
    for (let start = 0; start < 200; start++) {
      const res = await ctx.fetch(`${ENDPOINT}?q=criteria&domain=${domain}&start=${start}`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Linkedin-Version': API_VERSION, 'Content-Type': 'application/json' },
      });
      if (res.status === 401 || res.status === 403) {
        throw new ConfigError("Le jeton d'accès LinkedIn est expiré ou refusé. Générez-en un nouveau dans le portail développeur LinkedIn puis enregistrez-le dans Profil → LinkedIn.", 'linkedin_token_invalid');
      }
      if (res.status === 404) break;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (/no data found/i.test(text)) break;
        throw new Error(`LinkedIn (${domain}) : erreur ${res.status}`);
      }
      const json = (await res.json()) as { elements?: { snapshotData?: Record<string, unknown>[] }[]; paging?: { links?: { rel: string }[] } };
      const data = json.elements?.[0]?.snapshotData ?? [];
      for (const r of data) rows.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : String(v)])));
      const hasNext = json.paging?.links?.some((l) => l.rel === 'next');
      if (!hasNext || data.length === 0) break;
    }
    if (rows.length) out[domain] = rows;
  }
  return out;
}
