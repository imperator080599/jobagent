// Pilote de navigateur : ouvre le formulaire, le lit, le remplit, vérifie, et n'envoie
// que si la règle de la candidature le permet. Aucun accès base de données ici : le
// déroulé est piloté par des rappels (réponses, garde anti-doublon, journal), ce qui
// le rend testable sur des formulaires de démonstration locaux.
//
// Arrêts volontaires (jamais contournés) : CAPTCHA, connexion ou code de vérification,
// déclaration juridique non autorisée, question inconnue, erreur de validation, page
// sans formulaire reconnaissable. Tout ce qui a été lu et résolu est conservé, pour que
// la reprise (par vous ou par l'extension) ne vous fasse rien ressaisir.
import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { FormField } from '../questions.js';
import type { ResolvedField } from '../resolve.js';
import { detectPlatform, type PlatformId } from '../platforms.js';
import { adapterFor } from './adapters.js';

const INPAGE = readFileSync(new URL('./inpage.js', import.meta.url), 'utf8');

export interface PageScan {
  url: string;
  title: string;
  fields: FormField[];
  buttons: { next: string | null; nextLabel: string; submit: string | null; submitLabel: string; open: string | null; openHref: string };
  captcha: { kind: string } | null;
  access: { login: boolean; otp: boolean };
  errors: { key: string | null; message: string }[];
  confirmation: { text: string; url: string } | null;
}

export interface RunFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

export type HumanReason = 'captcha' | 'login' | 'otp' | 'legal' | 'validation' | 'unknown_form' | 'platform' | 'technical';

export type RunOutcome =
  | { status: 'submitted'; confirmation: { text: string; url: string } }
  | { status: 'ready_to_submit' }
  | { status: 'needs_answers' }
  | { status: 'needs_human'; reason: HumanReason; detail: string }
  | { status: 'uncertain'; detail: string }
  | { status: 'failed'; detail: string };

export interface RunStep {
  at: string;
  kind: 'open' | 'scan' | 'fill' | 'verify' | 'next' | 'submit' | 'confirm' | 'stop' | 'error';
  detail: string;
  page?: number;
  screenshot?: Uint8Array;
}

export interface RunResult {
  outcome: RunOutcome;
  /** Champs lus et réponses retenues, page par page (conservés pour la reprise). */
  pages: { url: string; fields: ResolvedField[] }[];
  steps: RunStep[];
  platform: PlatformId;
  finalUrl: string;
  durationMs: number;
}

export interface RunOptions {
  url: string;
  /** auto : envoi si tout est prêt ; prefill : tout est rempli, l'envoi revient à l'utilisateur. */
  mode: 'auto' | 'prefill';
  resolve: (fields: FormField[], page: number) => Promise<ResolvedField[]>;
  files: Map<string, RunFile>;
  /** Appelé juste avant le clic d'envoi ; renvoie false pour s'abstenir (garde anti-doublon). */
  beforeSubmit: () => Promise<boolean>;
  /** Plateformes sur lesquelles la candidature ne doit pas être poursuivie automatiquement. */
  allowPlatform: (p: PlatformId) => boolean;
  onStep?: (s: RunStep) => Promise<void> | void;
  browser?: Browser;
  /** Préparation du contexte de navigation (tests : formulaires de démonstration servis localement). */
  prepareContext?: (context: BrowserContext) => Promise<void>;
  maxPages?: number;
  timeoutMs?: number;
  screenshots?: boolean;
}

async function inject(page: Page): Promise<void> {
  await page.evaluate(INPAGE);
}

export async function scanPage(page: Page): Promise<PageScan> {
  await inject(page);
  return (await page.evaluate('window.__ja.scan()')) as PageScan;
}

async function settle(page: Page, ms = 8000): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: ms }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
}

/** Saisie d'un champ avec les actions natives du navigateur (événements réalistes, compatibles avec les formulaires React). */
async function fillField(page: Page, f: FormField, r: ResolvedField, files: Map<string, RunFile>): Promise<string | null> {
  const loc = page.locator(`[data-ja-key="${f.key}"]`).first();
  try {
    if (f.type === 'file') {
      const file = files.get(String(r.value));
      if (!file) return 'document introuvable';
      await loc.setInputFiles({ name: file.name, mimeType: file.mime, buffer: Buffer.from(file.data) });
      return null;
    }
    if (f.type === 'radio' || (f.type === 'checkbox' && f.options.length)) {
      const wanted = Array.isArray(r.value) ? r.value : [String(r.value)];
      for (const opt of f.options) {
        const target = page.locator(`input[type="${f.type}"][name="${f.name}"][value="${opt.value.replace(/"/g, '\\"')}"], [data-ja-key="${opt.value}"]`).first();
        const want = wanted.includes(opt.value);
        if (want) await target.check({ force: true });
        else if (f.type === 'checkbox') await target.uncheck({ force: true }).catch(() => {});
      }
      return null;
    }
    if (f.type === 'checkbox') {
      await loc.setChecked(Boolean(r.value), { force: true });
      return null;
    }
    if (f.tag === 'select') {
      await loc.selectOption(Array.isArray(r.value) ? r.value : String(r.value));
      return null;
    }
    if (f.tag === 'combobox') {
      await loc.click();
      await loc.fill(String(r.display || r.value));
      const option = page.locator('[role=option]', { hasText: String(r.display || r.value) }).first();
      await option.click({ timeout: 4000 });
      return null;
    }
    await loc.fill(String(r.value ?? ''));
    return null;
  } catch (err) {
    return String((err as Error).message).split('\n')[0]!.slice(0, 200);
  }
}

function sameValue(f: FormField, r: ResolvedField, actual: unknown, files: Map<string, RunFile>): boolean {
  if (f.type === 'file') return Array.isArray(actual) && actual.includes(files.get(String(r.value))?.name ?? '\u0000');
  if (f.type === 'checkbox' && !f.options.length) return actual === Boolean(r.value);
  if (Array.isArray(r.value)) return Array.isArray(actual) && r.value.every((v) => actual.includes(v));
  if (f.type === 'radio') return Array.isArray(actual) && actual.includes(String(r.value));
  if (f.tag === 'combobox') return true; // valeur affichée par le composant, contrôlée par les erreurs de validation
  return String(actual ?? '') === String(r.value ?? '');
}

export async function runApplication(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const steps: RunStep[] = [];
  const pages: RunResult['pages'] = [];
  const maxPages = opts.maxPages ?? 8;
  let platform = detectPlatform(opts.url);
  const step = async (s: Omit<RunStep, 'at'>) => {
    const full = { at: new Date().toISOString(), ...s };
    steps.push({ ...full, screenshot: undefined });
    await opts.onStep?.(full);
  };
  const ownBrowser = !opts.browser;
  let browser: Browser | null = opts.browser ?? null;
  let context: BrowserContext | null = null;
  const finish = (outcome: RunOutcome, finalUrl: string): RunResult => ({ outcome, pages, steps, platform, finalUrl, durationMs: Date.now() - started });
  try {
    if (!browser) {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
    }
    // Contexte isolé par candidature : aucun cookie partagé entre employeurs.
    context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(15_000);
    await opts.prepareContext?.(context);
    const page = await context.newPage();
    const deadline = started + (opts.timeoutMs ?? 180_000);
    const shot = async () => (opts.screenshots === false ? undefined : new Uint8Array(await page.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0))));

    if (!opts.allowPlatform(platform)) return finish({ status: 'needs_human', reason: 'platform', detail: `Plateforme ${platform} : candidature automatique non permise.` }, opts.url);
    const response = await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const status = response?.status() ?? 200;
    await step({ kind: 'open', detail: `${page.url()} (${status})` });
    if (status >= 500) return finish({ status: 'failed', detail: `Le site de candidature ne répond pas (erreur ${status}) : nouvel essai plus tard.` }, page.url());
    if (status === 404 || status === 410) return finish({ status: 'needs_human', reason: 'unknown_form', detail: `Page de l'offre introuvable (erreur ${status}) : l'offre a probablement été retirée.` }, page.url());

    // Page de l'offre sans formulaire : l'adaptateur (ou le bouton « Postuler ») mène au formulaire.
    const adapter = adapterFor(platform);
    await adapter.openForm?.(page);
    let scan = await scanPage(page);
    if (!scan.fields.some((f) => f.type !== 'search') && scan.buttons.open) {
      if (scan.buttons.openHref) {
        const next = detectPlatform(scan.buttons.openHref);
        if (!opts.allowPlatform(next)) return finish({ status: 'needs_human', reason: 'platform', detail: `Le bouton « Postuler » mène vers ${next}, où la candidature automatique n'est pas permise.` }, scan.buttons.openHref);
      }
      await page.locator(`[data-ja-key="${scan.buttons.open}"]`).first().click();
      await settle(page);
      platform = detectPlatform(page.url()) === 'generic' ? platform : detectPlatform(page.url());
      if (!opts.allowPlatform(platform)) return finish({ status: 'needs_human', reason: 'platform', detail: `Formulaire hébergé par ${platform} : candidature automatique non permise.` }, page.url());
      scan = await scanPage(page);
    }

    for (let p = 0; p < maxPages; p++) {
      if (Date.now() > deadline) return finish({ status: 'failed', detail: 'Délai maximal dépassé.' }, page.url());
      if (p > 0) scan = await scanPage(page);
      await step({ kind: 'scan', page: p, detail: `${scan.fields.length} champ(s) ; boutons : ${scan.buttons.submit ? `envoi « ${scan.buttons.submitLabel} »` : ''}${scan.buttons.next ? ` suivant « ${scan.buttons.nextLabel} »` : ''}` });
      if (scan.access.login || scan.access.otp) {
        await step({ kind: 'stop', page: p, detail: scan.access.otp ? 'code de vérification demandé' : 'connexion au compte candidat demandée', screenshot: await shot() });
        return finish({ status: 'needs_human', reason: scan.access.otp ? 'otp' : 'login', detail: scan.access.otp ? 'La plateforme demande un code de vérification : saisissez-le, puis reprenez la candidature.' : 'La plateforme demande de vous connecter à votre compte candidat. Vos identifiants ne sont jamais demandés par JobAgent : connectez-vous vous-même.' }, page.url());
      }
      // Étape de relecture sans champ : seule l'action d'envoi reste.
      if (!scan.fields.length && !(p > 0 && scan.buttons.submit)) {
        await step({ kind: 'stop', page: p, detail: 'aucun champ reconnu', screenshot: await shot() });
        return finish(scan.captcha ? { status: 'needs_human', reason: 'captcha', detail: `Contrôle anti-robots (${scan.captcha.kind}) avant le formulaire.` } : { status: 'needs_human', reason: 'unknown_form', detail: 'Aucun formulaire reconnaissable sur cette page.' }, page.url());
      }
      const resolved = scan.fields.length ? await opts.resolve(scan.fields, p) : [];
      pages.push({ url: page.url(), fields: resolved });
      const byKey = new Map(resolved.map((r) => [r.key, r]));

      // 1. Remplir tout ce qui est connu (même si d'autres réponses manquent : rien ne sera à ressaisir).
      const problems: string[] = [];
      for (const f of scan.fields) {
        const r = byKey.get(f.key);
        if (!r || r.status !== 'ready') continue;
        const err = await fillField(page, f, r, opts.files);
        if (err) problems.push(`${r.label} : ${err}`);
      }
      // 2. Contrôle : chaque valeur saisie est relue dans la page.
      for (const f of scan.fields) {
        const r = byKey.get(f.key);
        if (!r || r.status !== 'ready') continue;
        const actual = await page.evaluate(`window.__ja.valueOf(${JSON.stringify(f.key)})`);
        if (!sameValue(f, r, actual, opts.files)) problems.push(`${r.label} : valeur non retenue par la page`);
      }
      const ready = resolved.filter((r) => r.status === 'ready').length;
      await step({ kind: 'fill', page: p, detail: `${ready}/${resolved.length} champ(s) remplis${problems.length ? ` ; ${problems.length} problème(s)` : ''}`, screenshot: await shot() });
      if (problems.length) {
        await step({ kind: 'error', page: p, detail: problems.join(' | ') });
        return finish({ status: 'needs_human', reason: 'validation', detail: problems.join(' ; ') }, page.url());
      }
      const missing = resolved.filter((r) => r.required && r.status === 'missing');
      if (missing.length) return finish({ status: 'needs_answers' }, page.url());
      const human = resolved.filter((r) => r.required && r.status === 'needs_human');

      // 3. Page intermédiaire : étape suivante.
      if (scan.buttons.next && !scan.buttons.submit) {
        if (human.length && opts.mode === 'auto') return finish({ status: 'needs_human', reason: 'legal', detail: human.map((h) => h.reason).join(' ') }, page.url());
        if (human.length) return finish({ status: 'ready_to_submit' }, page.url());
        const before = page.url();
        const keysBefore = scan.fields.map((f) => f.key).join(',');
        await page.locator(`[data-ja-key="${scan.buttons.next}"]`).first().click();
        await settle(page);
        // Étape suivante affichée (champs différents), ou erreurs de validation : on attend l'un ou l'autre.
        let after = await scanPage(page);
        const waitUntil = Date.now() + 8_000;
        while (after.fields.map((f) => f.key).join(',') === keysBefore && !after.errors.length && before === page.url() && Date.now() < waitUntil) {
          await page.waitForTimeout(300);
          after = await scanPage(page);
        }
        await step({ kind: 'next', page: p, detail: before === page.url() ? 'étape suivante (même adresse)' : page.url() });
        if (after.errors.length && after.fields.some((f) => scan.fields.some((g) => g.key === f.key))) {
          await step({ kind: 'error', page: p, detail: after.errors.map((e) => e.message).join(' | '), screenshot: await shot() });
          return finish({ status: 'needs_human', reason: 'validation', detail: after.errors.map((e) => e.message).join(' ; ') }, page.url());
        }
        continue;
      }

      // 4. Page finale.
      if (!scan.buttons.submit) return finish({ status: 'needs_human', reason: 'unknown_form', detail: "Bouton d'envoi introuvable." }, page.url());
      if (opts.mode === 'prefill') {
        await step({ kind: 'stop', page: p, detail: 'formulaire prêt : envoi laissé à l’utilisateur' });
        return finish({ status: 'ready_to_submit' }, page.url());
      }
      if (human.length) return finish({ status: 'needs_human', reason: 'legal', detail: human.map((h) => h.reason).join(' ') }, page.url());
      if (scan.captcha) {
        await step({ kind: 'stop', page: p, detail: `contrôle anti-robots (${scan.captcha.kind}) : transmis à l’utilisateur`, screenshot: await shot() });
        return finish({ status: 'needs_human', reason: 'captcha', detail: `Contrôle anti-robots (${scan.captcha.kind}) avant l'envoi : il doit être résolu par vous. Tout le reste est rempli.` }, page.url());
      }
      // Garde anti-doublon : l'envoi est inscrit en base AVANT le clic.
      if (!(await opts.beforeSubmit())) return finish({ status: 'needs_human', reason: 'technical', detail: 'Envoi déjà engagé ou enregistré pour cette candidature : aucun second envoi.' }, page.url());
      const baseline = scan.confirmation?.text ?? null;
      const urlBefore = page.url();
      await page.locator(`[data-ja-key="${scan.buttons.submit}"]`).first().click();
      await settle(page, 15_000);
      await step({ kind: 'submit', page: p, detail: `clic sur « ${scan.buttons.submitLabel} »` });
      // L'envoi peut être asynchrone (page sans rechargement) : on attend une issue lisible, sans jamais recliquer.
      let after = await scanPage(page);
      const waitUntil = Date.now() + 20_000;
      const settled = (x: PageScan) => (x.confirmation && x.confirmation.text !== baseline) || x.captcha || (x.errors.length > 0 && x.fields.length > 0);
      while (!settled(after) && Date.now() < waitUntil) {
        await page.waitForTimeout(400);
        await settle(page, 2_000);
        after = await scanPage(page);
      }
      const confirmed = after.confirmation && after.confirmation.text !== baseline ? after.confirmation : null;
      if (confirmed && !after.errors.some((e) => e.key)) {
        await step({ kind: 'confirm', page: p, detail: confirmed.text, screenshot: await shot() });
        return finish({ status: 'submitted', confirmation: confirmed }, page.url());
      }
      if (after.captcha) {
        await step({ kind: 'stop', page: p, detail: `contrôle anti-robots (${after.captcha.kind}) après le clic d'envoi`, screenshot: await shot() });
        return finish({ status: 'uncertain', detail: `Un contrôle anti-robots (${after.captcha.kind}) est apparu au moment de l'envoi : la candidature n'est probablement pas partie. Vérifiez-le avant toute nouvelle tentative.` }, page.url());
      }
      if (after.errors.length && after.fields.length) {
        // Formulaire réaffiché avec des erreurs : l'envoi a été refusé par la page (rien n'est parti).
        await step({ kind: 'error', page: p, detail: after.errors.map((e) => e.message).join(' | '), screenshot: await shot() });
        return finish({ status: 'needs_human', reason: 'validation', detail: `La page a refusé l'envoi : ${after.errors.map((e) => e.message).join(' ; ')}` }, page.url());
      }
      await step({ kind: 'stop', page: p, detail: 'aucune confirmation lisible après l’envoi', screenshot: await shot() });
      return finish({ status: 'uncertain', detail: `Aucune confirmation lisible après l'envoi (${urlBefore === page.url() ? 'même page' : page.url()}).` }, page.url());
    }
    return finish({ status: 'needs_human', reason: 'unknown_form', detail: `Plus de ${maxPages} étapes : formulaire non reconnu.` }, opts.url);
  } catch (err) {
    const detail = String((err as Error).message ?? err).split('\n')[0]!.slice(0, 300);
    await step({ kind: 'error', detail }).catch(() => {});
    return finish({ status: 'failed', detail }, opts.url);
  } finally {
    await context?.close().catch(() => {});
    if (ownBrowser) await browser?.close().catch(() => {});
  }
}
