import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeTestEnv, signedIn, type FetchMock, type TestEnv } from '../helpers.js';
import { forUser } from '../../src/core/context.js';
import { setSecret } from '../../src/core/secrets.js';
import { actionItems, jobSightings, jobs, sourceRuns, sources, tasks } from '../../src/db/schema.js';
import { newId } from '../../src/db/ids.js';
import { schedulerTick } from '../../src/pipeline/scheduler.js';
import { runWorker } from '../../src/pipeline/worker.js';
import { detectConnector } from '../../src/search/connectors/index.js';
import { parseFeed } from '../../src/search/connectors/engines.js';
import { isRelevant, runSource } from '../../src/search/engine.js';
import { resetHttpCaches } from '../../src/search/http.js';
import { expandTitles, searchTerms, synonymsOf, titleAffinity } from '../../src/search/synonyms.js';
import { SearchCriteria } from '../../src/shared/search.js';

// ── Réponses enregistrées (formes réelles des API, contenus fictifs) ──
const longText = (topic: string) => `<p>${topic}</p><ul><li>Analyse de la qualité des résultats, de la dette nette et du BFR</li><li>Rédaction de rapports de due diligence</li></ul><p>${'Vous rejoignez une équipe de quinze personnes au service de fonds et de groupes industriels. '.repeat(6)}</p>`;
const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ghJob = (id: number, title: string, location = 'Paris, France') => ({ id, title, absolute_url: `https://job-boards.greenhouse.io/northwind/jobs/${id}`, updated_at: '2026-11-05T10:00:00-05:00', first_published: '2026-11-01T09:00:00-04:00', application_deadline: null, company_name: 'Northwind Capital', location: { name: location }, content: encode(longText(`Poste : ${title}`)), departments: [{ id: 1, name: 'Advisory', child_ids: [], parent_id: null }], offices: [{ id: 1, name: location, location, child_ids: [], parent_id: null }] });

let greenhouseJobs = [ghJob(101, 'Senior Analyst, Transaction Services'), ghJob(102, 'Software Engineer, Platform'), ghJob(103, 'Analyste Financial Due Diligence (H/F)'), ghJob(104, 'Consultant Transaction Services', 'Singapore')];
let blocked = false;
const requests: { url: string; init?: RequestInit }[] = [];

const leverPosting = (i: number) => ({ id: `0000${i}`.slice(-5) + '-aaaa-bbbb-cccc-000000000000', text: i === 3 ? 'M&A Analyst' : `Sales Representative ${i}`, hostedUrl: `https://jobs.lever.co/hartwell/${i}`, applyUrl: `https://jobs.lever.co/hartwell/${i}/apply`, createdAt: 1793000000000, country: 'FR', workplaceType: 'hybrid', categories: { location: 'Paris', team: 'Corporate Finance', commitment: 'Full-time', allLocations: ['Paris'] }, description: '<div>Vous participez à des opérations de fusions-acquisitions.</div>', lists: [{ text: 'Profil', content: '<li>Deux à quatre ans en M&amp;A ou en audit</li>' }], additional: `<div>${'Rejoignez une équipe reconnue. '.repeat(10)}</div>` });

const net: FetchMock = (url, init) => {
  requests.push({ url, init });
  const u = new URL(url);
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (blocked) return new Response('<html>Access denied</html>', { status: 403 });
  if (u.host === 'boards-api.greenhouse.io') return u.pathname.includes('/northwind/') ? json({ jobs: greenhouseJobs, meta: { total: greenhouseJobs.length } }) : new Response('{}', { status: 404 });
  if (u.host === 'api.lever.co') {
    const skip = Number(u.searchParams.get('skip'));
    const all = Array.from({ length: 130 }, (_, i) => leverPosting(i + 1));
    return json(all.slice(skip, skip + Number(u.searchParams.get('limit'))));
  }
  if (u.host === 'api.smartrecruiters.com') {
    if (/\/postings\/\d+$/.test(u.pathname)) return json({ applyUrl: 'https://jobs.smartrecruiters.com/Aubrac/apply/7002', postingUrl: 'https://jobs.smartrecruiters.com/Aubrac/7002', jobAd: { sections: { jobDescription: { title: 'Missions', text: longText('Contrôle de gestion') }, qualifications: { title: 'Profil', text: '<p>Trois ans en FP&amp;A</p>' } } } });
    return json({ offset: 0, limit: 100, totalFound: 2, content: [{ id: '7001', name: 'Chef de rayon', company: { name: 'Aubrac Distribution' }, location: { city: 'Lyon', country: 'fr', fullLocation: 'Lyon, France' }, releasedDate: '2026-11-02T08:00:00.000Z' }, { id: '7002', name: 'Contrôleur de gestion', company: { name: 'Aubrac Distribution' }, location: { city: 'Lyon', country: 'fr', fullLocation: 'Lyon, France' }, typeOfEmployment: { id: 'permanent', label: 'Full-time' }, releasedDate: '2026-11-03T08:00:00.000Z' }] });
  }
  if (u.host === 'entreprise.francetravail.fr') return String(init?.body).includes('client_secret=bon-secret') ? json({ access_token: 'jeton-test', expires_in: 1499 }) : new Response('{"error":"invalid_client"}', { status: 400 });
  if (u.host === 'api.francetravail.io') {
    const [start] = (u.searchParams.get('range') ?? '0-149').split('-').map(Number);
    const total = 160;
    const n = Math.min(150, total - start!);
    return json({ resultats: Array.from({ length: n }, (_, i) => ({ id: `FT${start! + i}`, intitule: start! + i === 155 ? 'Auditeur financier confirmé' : `Auditeur financier H/F n°${start! + i}`, description: 'Audit légal de comptes sociaux et consolidés. '.repeat(8), dateCreation: '2026-11-08T10:00:00.000Z', lieuTravail: { libelle: '69 - LYON 03' }, entreprise: { nom: `Cabinet ${start! + i}` }, typeContrat: 'CDI', origineOffre: { urlOrigine: `https://candidat.francetravail.fr/offres/recherche/detail/FT${start! + i}` } })) }, n < 150 ? 200 : 206, { 'content-range': `offres ${start}-${start! + n - 1}/${total}` });
  }
  if (u.host === 'api.adzuna.com') return json({ count: 1, results: [{ id: '55', title: 'Financial <strong>Analyst</strong>', description: 'We are looking for a financial analyst to join our FP&A team…', created: '2026-11-09T00:00:00Z', redirect_url: 'https://www.adzuna.co.uk/land/ad/55?se=x', company: { display_name: 'Brightwater Energy' }, location: { display_name: 'London, UK' }, contract_type: 'permanent', salary_min: 55000, salary_max: 65000 }] });
  if (u.host === 'www.adzuna.co.uk') return u.pathname === '/robots.txt' ? new Response('User-agent: *\nDisallow: /land/', { status: 200 }) : new Response('nope', { status: 403 });
  if (u.host === 'carrieres.solene.example') return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>Offres</title><item><title>Analyste M&amp;A</title><link>https://carrieres.solene.example/jobs/12</link><guid>job-12</guid><pubDate>Mon, 09 Nov 2026 09:00:00 +0000</pubDate><description><![CDATA[<p>${'Vous intervenez sur des opérations de fusions-acquisitions. '.repeat(6)}</p>]]></description></item><item><title>Assistant de direction</title><link>https://carrieres.solene.example/jobs/13</link><guid>job-13</guid></item></channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  return new Response('not found', { status: 404 });
};

let t: TestEnv;
let api: Awaited<ReturnType<typeof signedIn>>['api'];
let userId: string;
const uctx = () => forUser(t.ctx, userId);
const addSource = async (type: string, name: string, config: Record<string, unknown>) => (await t.ctx.db.insert(sources).values({ id: newId('src'), userId, type, name, config }).returning())[0]!;

beforeAll(async () => {
  resetHttpCaches();
  t = await makeTestEnv({ fetch: net });
  ({ api, userId } = await signedIn(t));
});
afterAll(() => t.close());
beforeEach(() => {
  requests.length = 0;
  blocked = false;
});

describe('synonymes et sélection', () => {
  it('élargit un intitulé à ses équivalents, dans les deux langues', () => {
    expect(synonymsOf('Analyste Transaction Services')).toEqual(expect.arrayContaining(['financial due diligence', 'deal advisory']));
    const variants = expandTitles(['Consultant Transaction Services', 'Contrôleur de gestion']);
    expect(variants.slice(0, 2)).toEqual(['Consultant Transaction Services', 'Contrôleur de gestion']);
    expect(variants).toEqual(expect.arrayContaining(['FP&A', 'consultant financial due diligence']));
    expect(searchTerms(['Consultant Transaction Services H/F'])).toEqual(['Consultant Transaction Services H/F', 'transaction services']);
    expect(titleAffinity('Senior Analyst, Transaction Services (m/f/d)', ['transaction services'])).toBe(1);
    expect(titleAffinity('Software Engineer', ['transaction services'])).toBe(0);
    // Sigles à esperluette et variantes de langue.
    expect(titleAffinity('M&A Analyst', ['Analyste M&A'])).toBe(1);
    expect(titleAffinity('FP&A Manager', ['FP&A'])).toBe(1);
    expect(titleAffinity('Marketing Analyst', ['Analyste M&A'])).toBe(0.5);
  });

  it('retient une offre proche d’un intitulé visé et respecte les règles explicites', () => {
    const criteria = SearchCriteria.parse({ titles: ['Consultant Transaction Services'], countries: ['FR'], excludeKeywords: ['stage'] });
    const profiles = [{ criteria, targets: expandTitles(criteria.titles) }];
    const now = new Date();
    expect(isRelevant({ company: 'X', title: 'Analyste Financial Due Diligence (H/F)', location: 'Paris' }, profiles, now).relevant).toBe(true);
    expect(isRelevant({ company: 'X', title: 'Software Engineer', location: 'Paris' }, profiles, now).relevant).toBe(false);
    expect(isRelevant({ company: 'X', title: 'Consultant Transaction Services', location: 'Singapore' }, profiles, now)).toMatchObject({ relevant: false, reason: expect.stringContaining('pays') });
    expect(isRelevant({ company: 'X', title: 'Stage Transaction Services', location: 'Paris' }, profiles, now).relevant).toBe(false);
    // Lieu inconnu : le doute profite à l'offre.
    expect(isRelevant({ company: 'X', title: 'Consultant Transaction Services' }, profiles, now).relevant).toBe(true);
  });

  it('reconnaît la plateforme d’un site carrières à son adresse', () => {
    expect(detectConnector('https://boards.greenhouse.io/northwind')).toMatchObject({ connector: { type: 'greenhouse' }, config: { board: 'northwind' } });
    expect(detectConnector('job-boards.greenhouse.io/northwind/jobs/123')).toMatchObject({ config: { board: 'northwind' } });
    expect(detectConnector('https://jobs.eu.lever.co/hartwell')).toMatchObject({ connector: { type: 'lever' }, config: { site: 'hartwell', region: 'eu' } });
    expect(detectConnector('https://jobs.ashbyhq.com/Acme%20Labs')).toMatchObject({ connector: { type: 'ashby' }, config: { board: 'Acme Labs' } });
    expect(detectConnector('https://careers.smartrecruiters.com/Aubrac')).toMatchObject({ connector: { type: 'smartrecruiters' } });
    expect(detectConnector('https://carrieres.solene.example/jobs.rss')).toMatchObject({ connector: { type: 'feed' } });
    expect(detectConnector('https://www.exemple.com/carrieres')).toBeNull();
  });

  it('lit un flux RSS ou Atom', () => {
    expect(parseFeed('<feed><entry><title>Analyste</title><link href="https://x.example/j/1"/><id>tag:1</id><updated>2026-11-01T00:00:00Z</updated><summary>Texte</summary></entry></feed>')[0]).toMatchObject({ title: 'Analyste', link: 'https://x.example/j/1', id: 'tag:1', description: 'Texte' });
  });
});

describe('collecte', () => {
  it('ne collecte rien tant qu’aucune recherche n’est définie, et le dit', async () => {
    const source = await addSource('greenhouse', 'Northwind Capital', { board: 'northwind', company: 'Northwind Capital' });
    await expect(runSource(uctx(), source.id)).rejects.toThrow(/Définissez au moins une recherche/);
    expect(requests).toHaveLength(0);
    const [s] = await t.ctx.db.select().from(sources).where(eq(sources.id, source.id));
    expect(s!.health).toBe('needs_config');
    expect((await api.get('/api/inbox')).data.items.some((i: any) => i.type === 'setup.search')).toBe(true);
    const created = await api.post('/api/search/profiles', { name: 'Transaction Services', criteria: { titles: ['Consultant Transaction Services', 'Contrôleur de gestion', 'Analyste M&A', 'Auditeur financier', 'Financial Analyst'], countries: ['FR', 'GB'], excludeKeywords: ['stage'] } });
    expect(created.status).toBe(200);
    expect((await api.get('/api/inbox')).data.items.some((i: any) => i.type === 'setup.search')).toBe(false);
  });

  it('lit tout le site carrières, n’enregistre que les offres pertinentes et mesure la couverture', async () => {
    const [source] = await t.ctx.db.select().from(sources).where(and(eq(sources.userId, userId), eq(sources.type, 'greenhouse')));
    const { run, created } = await runSource(uctx(), source!.id, { trigger: 'manual' });
    expect(run).toMatchObject({ status: 'complete', itemsSeen: 4, itemsRelevant: 2, itemsNew: 2, itemsDuplicate: 0, requests: 1, incompleteReason: '' });
    expect(created).toHaveLength(2);
    const stored = await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.companyNorm, 'northwind capital')));
    expect(stored.map((j) => j.title).sort()).toEqual(['Analyste Financial Due Diligence (H/F)', 'Senior Analyst, Transaction Services']);
    // Le contenu encodé en entités HTML est restitué en texte lisible.
    expect(stored[0]!.descriptionText).toContain('- Rédaction de rapports de due diligence');
    expect(stored[0]!.descriptionText).not.toContain('&lt;');
    expect(stored[0]!).toMatchObject({ city: 'Paris', country: 'FR', externalRef: expect.stringMatching(/^gh:10[13]$/) });
    // Chaque nouvelle offre part en qualification, une seule fois.
    const queued = await t.ctx.db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.type, 'job.qualify')));
    expect(queued).toHaveLength(2);
    const cov = (await api.get('/api/search/sources')).data.sources.find((s: any) => s.id === source!.id);
    expect(cov).toMatchObject({ health: 'ok', liveJobs: 2, lastRun: { status: 'complete', itemsSeen: 4, itemsRelevant: 2, itemsNew: 2 } });
    expect(cov.lastCompleteAt).toBeTruthy();
  });

  it('une seconde lecture ne crée aucun doublon', async () => {
    const [source] = await t.ctx.db.select().from(sources).where(and(eq(sources.userId, userId), eq(sources.type, 'greenhouse')));
    const { run } = await runSource(uctx(), source!.id);
    expect(run).toMatchObject({ status: 'complete', itemsNew: 0, itemsDuplicate: 2 });
    expect(await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.companyNorm, 'northwind capital')))).toHaveLength(2);
  });

  it('détecte une offre retirée après une lecture complète, sans toucher aux candidatures parties', async () => {
    const [source] = await t.ctx.db.select().from(sources).where(and(eq(sources.userId, userId), eq(sources.type, 'greenhouse')));
    const all = await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.companyNorm, 'northwind capital')));
    const sent = all.find((j) => j.externalRef === 'gh:103')!;
    await api.post(`/api/applications/${sent.id}/submitted`, { channel: 'Site carrières' });
    greenhouseJobs = [ghJob(102, 'Software Engineer, Platform')];
    const { run } = await runSource(uctx(), source!.id);
    expect(run).toMatchObject({ status: 'complete', itemsExpired: 1 });
    const after = await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.companyNorm, 'northwind capital')));
    expect(after.find((j) => j.externalRef === 'gh:101')).toMatchObject({ stage: 'expired' });
    expect(after.find((j) => j.externalRef === 'gh:101')!.expiredAt).toBeTruthy();
    // La candidature envoyée reste dans le suivi, intacte.
    expect(after.find((j) => j.externalRef === 'gh:103')).toMatchObject({ stage: 'sent', expiredAt: null });
    expect((await t.ctx.db.select().from(jobSightings).where(eq(jobSightings.sourceId, source!.id))).every((s) => s.goneAt)).toBe(true);
    // L'offre revient en ligne : elle redevient analysable, sans nouvelle fiche.
    greenhouseJobs = [ghJob(101, 'Senior Analyst, Transaction Services')];
    await runSource(uctx(), source!.id);
    const back = (await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.externalRef, 'gh:101'))))[0]!;
    expect(back).toMatchObject({ stage: 'to_analyze', expiredAt: null });
    expect(await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.companyNorm, 'northwind capital')))).toHaveLength(2);
  });

  it('pagine jusqu’au bout et dit quand la lecture est partielle', async () => {
    const source = await addSource('lever', 'Hartwell', { site: 'hartwell', company: 'Hartwell & Associés', region: 'global' });
    const full = await runSource(uctx(), source.id);
    expect(full.run).toMatchObject({ status: 'complete', itemsSeen: 130, itemsRelevant: 1, itemsNew: 1, pagesFetched: 2 });
    const [job] = await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.companyNorm, 'hartwell&associes')));
    expect(job).toMatchObject({ title: 'M&A Analyst', remote: 'hybrid', country: 'FR' });
    expect(job!.descriptionText).toContain('Deux à quatre ans en M&A');
    // Plafond de requêtes atteint : couverture partielle, raison donnée, aucune offre déclarée retirée.
    const partial = await runSource(uctx(), source.id, { maxRequests: 1 });
    expect(partial.run).toMatchObject({ status: 'partial', itemsExpired: 0 });
    expect(partial.run.incompleteReason).toContain('plafond');
    expect((await t.ctx.db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.expiredAt).toBeNull();
  });

  it('ne charge le texte complet que pour les offres pertinentes', async () => {
    const source = await addSource('smartrecruiters', 'Aubrac Distribution', { company: 'Aubrac', name: 'Aubrac Distribution' });
    const { run } = await runSource(uctx(), source.id);
    expect(run).toMatchObject({ status: 'complete', itemsSeen: 2, itemsRelevant: 1, itemsNew: 1 });
    expect(requests.filter((r) => /\/postings\/\d+$/.test(new URL(r.url).pathname)).map((r) => r.url)).toEqual(['https://api.smartrecruiters.com/v1/companies/Aubrac/postings/7002']);
    const [job] = await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.title, 'Contrôleur de gestion')));
    expect(job!.descriptionText).toContain('Trois ans en FP&A');
    expect(job!.applyUrl).toBe('https://jobs.smartrecruiters.com/Aubrac/apply/7002');
  });

  it('ne déclare jamais exhaustif un flux, et n’en déduit aucun retrait', async () => {
    const source = await addSource('feed', 'Solène Conseil', { url: 'https://carrieres.solene.example/jobs.rss', company: 'Solène Conseil' });
    const { run } = await runSource(uctx(), source.id);
    expect(run).toMatchObject({ status: 'partial', itemsSeen: 2, itemsRelevant: 1, itemsNew: 1 });
    expect(run.incompleteReason).toContain('offres les plus récentes');
    const cov = (await api.get('/api/search/sources')).data.sources.find((s: any) => s.id === source.id);
    expect(cov.lastCompleteAt).toBeNull();
  });

  it('ne contourne pas un refus d’accès : la source passe en panne et vous êtes prévenu', async () => {
    const [source] = await t.ctx.db.select().from(sources).where(and(eq(sources.userId, userId), eq(sources.type, 'greenhouse')));
    blocked = true;
    const { run } = await runSource(uctx(), source!.id);
    expect(run.status).toBe('failed');
    expect(run.error).toContain("refuse l'accès automatisé");
    expect(requests).toHaveLength(1); // une seule tentative, aucune ruse
    expect((await t.ctx.db.select().from(sources).where(eq(sources.id, source!.id)))[0]!.health).toBe('failing');
    const alert = (await api.get('/api/inbox')).data.items.find((i: any) => i.type === 'system.alert' && i.title.includes('Source en panne'));
    expect(alert).toBeTruthy();
    // Aucune offre n'est déclarée retirée sur la foi d'une lecture en échec.
    expect((await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.externalRef, 'gh:101'))))[0]!.expiredAt).toBeNull();
    blocked = false;
    await runSource(uctx(), source!.id);
    expect((await t.ctx.db.select().from(sources).where(eq(sources.id, source!.id)))[0]!.health).toBe('ok');
    expect((await api.get('/api/inbox')).data.items.some((i: any) => i.title.includes('Source en panne'))).toBe(false);
  });
});

describe('moteurs avec identifiants', () => {
  it('France Travail : jeton, pagination par plages, total annoncé', async () => {
    const source = await addSource('francetravail', 'France Travail', { clientId: 'PAR_jobagent_abcdef', departments: '69', maxDays: 31 });
    await expect(runSource(uctx(), source.id)).rejects.toThrow(/clé secrète/);
    expect((await t.ctx.db.select().from(sources).where(eq(sources.id, source.id)))[0]!.health).toBe('needs_config');
    await setSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'francetravail_client_secret', 'mauvais');
    await expect(runSource(uctx(), source.id)).rejects.toThrow(/refuse ces identifiants/);
    await setSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'francetravail_client_secret', 'bon-secret');
    requests.length = 0;
    const { run } = await runSource(uctx(), source.id, { maxRequests: 200 });
    const searches = requests.filter((r) => r.url.includes('api.francetravail.io'));
    // Le secret ne voyage que vers le service d'authentification, jamais dans une adresse.
    expect(requests.every((r) => !r.url.includes('bon-secret'))).toBe(true);
    expect((searches[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer jeton-test');
    const auditeur = searches.filter((r) => new URL(r.url).searchParams.get('motsCles') === 'Auditeur financier');
    expect(auditeur.map((r) => new URL(r.url).searchParams.get('range'))).toEqual(['0-149', '150-299']);
    expect(new URL(auditeur[0]!.url).searchParams.get('departement')).toBe('69');
    expect(run.status).toBe('complete');
    expect(run.itemsSeen).toBeGreaterThanOrEqual(160);
    const stored = await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.title, 'Auditeur financier confirmé')));
    expect(stored[0]).toMatchObject({ city: 'Lyon', country: 'FR', contractType: 'cdi', companyName: 'Cabinet 155' });
  });

  it('Adzuna : un extrait ne suffit pas pour une analyse ATS', async () => {
    const source = await addSource('adzuna', 'Adzuna', { appId: 'abc12345', countries: 'gb', maxDays: 30 });
    await setSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'adzuna_app_key', 'cle-adzuna');
    const { run, created } = await runSource(uctx(), source.id);
    expect(run).toMatchObject({ status: 'complete', itemsRelevant: 1, itemsNew: 1 });
    const job = (await t.ctx.db.select().from(jobs).where(eq(jobs.id, created[0]!)))[0]!;
    expect(job).toMatchObject({ title: 'Financial Analyst', companyName: 'Brightwater Energy', city: 'London', country: 'GB', salaryMin: 55000, salaryCurrency: 'GBP' });
    expect((job.flags as any).partialDescription).toBe(true);
    // Qualification possible sur l'extrait ; l'analyse ATS attend le texte complet.
    await t.ctx.db.update(jobs).set({ stage: 'to_analyze' }).where(eq(jobs.id, job.id));
    await t.ctx.db.delete(tasks).where(eq(tasks.userId, userId));
    await t.ctx.db.insert(tasks).values({ id: newId('task'), userId, type: 'job.ats', payload: { jobId: job.id }, idempotencyKey: `job.ats:${job.id}`, runAfter: t.ctx.now() });
    await runWorker(t.ctx, { budgetMs: 30_000, workerId: 'test' });
    const [task] = await t.ctx.db.select().from(tasks).where(eq(tasks.idempotencyKey, `job.ats:${job.id}`));
    expect(task!.status).toBe('blocked');
    // Le site d'origine interdit la lecture automatique (robots.txt) : la page n'a pas été demandée.
    expect(requests.some((r) => r.url.includes('/land/ad/55'))).toBe(false);
    const ask = (await api.get('/api/inbox')).data.items.find((i: any) => i.type === 'job.needs_text' && i.jobId === job.id);
    expect(ask).toBeTruthy();
    // L'utilisateur colle le texte complet : la marque est levée et l'analyse reprend.
    const pasted = await api.patch(`/api/jobs/${job.id}`, { descriptionText: 'Financial Analyst — FP&A. '.repeat(40) });
    expect(pasted.data.job.flags.partialDescription).toBeUndefined();
    expect((await t.ctx.db.select().from(tasks).where(eq(tasks.idempotencyKey, `job.ats:${job.id}`)))[0]!.status).toBe('queued');
    expect((await api.get('/api/inbox')).data.items.some((i: any) => i.type === 'job.needs_text')).toBe(false);
  });
});

describe('planification et API', () => {
  it('ne relance une source qu’à son échéance', async () => {
    await t.ctx.db.delete(tasks).where(eq(tasks.userId, userId));
    const first = await schedulerTick(t.ctx);
    expect(first.started.some((s) => s.startsWith('search.sources'))).toBe(true);
    // Toutes les sources viennent d'être lues : rien n'est remis en file.
    expect(await t.ctx.db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.type, 'source.run')))).toHaveLength(0);
    t.clock.advance(7 * 3600_000);
    await schedulerTick(t.ctx);
    const queued = await t.ctx.db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.type, 'source.run')));
    const enabled = await t.ctx.db.select().from(sources).where(and(eq(sources.userId, userId), eq(sources.enabled, true)));
    expect(queued.length).toBe(enabled.filter((s) => s.type !== 'manual').length);
    // Un second passage ne duplique rien.
    t.clock.advance(11 * 60_000);
    await schedulerTick(t.ctx);
    expect(await t.ctx.db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.type, 'source.run')))).toHaveLength(queued.length);
  });

  it('ajoute une source depuis l’adresse d’un site carrières et tient l’historique', async () => {
    const detected = await api.post('/api/search/detect', { url: 'https://boards.greenhouse.io/northwind' });
    expect(detected.data).toMatchObject({ type: 'greenhouse', config: { board: 'northwind' } });
    const bad = await api.post('/api/search/sources', { type: 'greenhouse', name: 'Mauvais', config: { board: 'avec espace', company: 'X' } });
    expect(bad.status).toBe(400);
    const company = await api.post('/api/search/companies', { name: 'Valmont Advisory', tier: 'dream', careersUrl: 'https://jobs.ashbyhq.com/valmont' });
    expect(company.data).toMatchObject({ detected: 'Ashby', source: { type: 'ashby', name: 'Valmont Advisory' } });
    const connectors = await api.get('/api/search/connectors');
    expect(connectors.data.connectors.map((k: any) => k.type)).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'francetravail', 'adzuna', 'feed']);
    // Les secrets ne sont jamais renvoyés : seulement leur présence.
    expect(JSON.stringify(connectors.data)).not.toContain('bon-secret');
    expect(connectors.data.connectors.find((k: any) => k.type === 'francetravail').secrets[0].configured).toBe(true);
    const runs = await api.get('/api/search/runs');
    expect(runs.data.runs.length).toBeGreaterThan(8);
    expect(runs.data.runs[0]).toHaveProperty('itemsSeen');
    expect((await t.ctx.db.select().from(sourceRuns).where(eq(sourceRuns.userId, userId))).every((r) => r.status !== 'running')).toBe(true);
    expect((await t.ctx.db.select().from(actionItems).where(and(eq(actionItems.userId, userId), eq(actionItems.status, 'open')))).every((a) => !a.title.includes('undefined'))).toBe(true);
  });
});
