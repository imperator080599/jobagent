// Particularités de chaque ATS : comment atteindre le formulaire depuis la page de
// l'offre. Le reste (lecture des champs, remplissage, envoi, confirmation) est commun
// et repose sur la structure standard des formulaires HTML.
import type { Page } from 'playwright-core';
import type { PlatformId } from '../platforms.js';

export interface Adapter {
  /** Mène de la page de l'offre au formulaire de candidature, si l'adresse n'y mène pas directement. */
  openForm?: (page: Page) => Promise<void>;
  /** Adresse du formulaire déduite de l'adresse de l'offre (sans charger la page). */
  formUrl?: (url: string) => string;
}

const goto = async (page: Page, url: string) => {
  if (url !== page.url()) await page.goto(url, { waitUntil: 'domcontentloaded' });
};

const suffix = (re: RegExp, add: string) => (url: string) => {
  const u = new URL(url);
  if (re.test(u.pathname) && !u.pathname.replace(/\/$/, '').endsWith(add)) u.pathname = `${u.pathname.replace(/\/$/, '')}/${add}`;
  return u.toString();
};

const ADAPTERS: Partial<Record<PlatformId, Adapter>> = {
  // jobs.lever.co/{entreprise}/{id} → /apply
  lever: { formUrl: suffix(/^\/[^/]+\/[0-9a-f-]{36}\/?$/i, 'apply') },
  // jobs.ashbyhq.com/{org}/{id} → /application
  ashby: { formUrl: suffix(/^\/[^/]+\/[0-9a-f-]{36}\/?$/i, 'application') },
  // apply.workable.com/{entreprise}/j/{id}/ → /apply/
  workable: { formUrl: suffix(/^\/[^/]+\/j\/[A-Z0-9]+\/?$/i, 'apply') },
  // {entreprise}.recruitee.com/o/{offre} → /c/new
  recruitee: { formUrl: suffix(/^\/o\/[^/]+\/?$/i, 'c/new') },
  // {entreprise}.breezy.hr/p/{id} → /apply
  breezy: { formUrl: suffix(/^\/p\/[^/]+\/?$/i, 'apply') },
};

export function adapterFor(id: PlatformId): Adapter & { openForm: (page: Page) => Promise<void> } {
  const a = ADAPTERS[id] ?? {};
  return {
    ...a,
    openForm: a.openForm ?? (async (page: Page) => {
      if (a.formUrl) await goto(page, a.formUrl(page.url()));
    }),
  };
}

/** Adresse à ouvrir pour candidater (formulaire direct quand la plateforme le permet). */
export function applicationUrl(id: PlatformId, url: string): string {
  try {
    return ADAPTERS[id]?.formUrl?.(url) ?? url;
  } catch {
    return url;
  }
}
