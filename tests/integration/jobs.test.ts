import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeTestEnv, signedIn, type FetchMock, type TestEnv } from '../helpers.js';
import { forUser } from '../../src/core/context.js';
import { jobSightings, jobs, sources, stageHistory, tasks } from '../../src/db/schema.js';
import { newId } from '../../src/db/ids.js';
import { checkExistingJob, ingestJob, manualSource, normalizeJob } from '../../src/search/ingest.js';
import { resetHttpCaches } from '../../src/search/http.js';
import { setStage } from '../../src/tracker/stage.js';

const DESCRIPTION = `About the role
Northwind Capital is looking for a Senior Analyst to join its Transaction Services team in Luxembourg.
You will take part in buy-side and sell-side financial due diligence engagements for private equity funds and corporates.

Your responsibilities
- Analyse historical financial information, quality of earnings, net debt and working capital
- Prepare databooks and due diligence reports for investment committees
- Coordinate with tax, legal and valuation specialists throughout the transaction

Your profile
- 3 to 5 years of experience in audit or transaction services, ideally in a Big Four firm
- Strong command of IFRS and Lux GAAP, advanced Excel
- Fluent in English and French
We offer a permanent contract.`;

const PAGE = (extra = '') => `<!doctype html><html><head><title>Senior Analyst</title><meta property="og:site_name" content="Northwind Capital">
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Senior Analyst, Transaction Services',
  datePosted: '2026-10-28',
  hiringOrganization: { '@type': 'Organization', name: 'Northwind Capital' },
  jobLocation: { '@type': 'Place', address: { addressLocality: 'Luxembourg', addressCountry: 'LU' } },
  description: DESCRIPTION.split('\n').map((l) => `<p>${l}</p>`).join(''),
})}</script></head><body><main><h1>Senior Analyst, Transaction Services</h1>${extra}</main></body></html>`;

let t: TestEnv;
let api: Awaited<ReturnType<typeof signedIn>>['api'];
let userId: string;
const requests: string[] = [];

const net: FetchMock = (url) => {
  requests.push(url);
  const u = new URL(url);
  if (u.pathname === '/robots.txt') {
    if (u.host === 'closed.example') return new Response('User-agent: *\nDisallow: /', { status: 200 });
    return new Response('User-agent: *\nDisallow: /admin', { status: 200 });
  }
  if (u.host === 'careers.northwind.example') return new Response(PAGE(), { status: 200, headers: { 'content-type': 'text/html' } });
  if (u.host === 'blocked.example') return new Response('<html>Access denied – captcha</html>', { status: 403 });
  if (u.host === 'empty.example') return new Response('<html><body><p>Rien</p></body></html>', { status: 200 });
  return new Response('not found', { status: 404 });
};

beforeAll(async () => {
  resetHttpCaches();
  t = await makeTestEnv({ fetch: net });
  ({ api, userId } = await signedIn(t));
});
afterAll(() => t.close());

const uctx = () => forUser(t.ctx, userId);

describe('ajout manuel d’une offre', () => {
  let jobId = '';

  it('lit la page indiquée et crée la fiche', async () => {
    const res = await api.post('/api/jobs', { url: 'https://careers.northwind.example/jobs/4471?utm_source=linkedin' });
    expect(res.status).toBe(201);
    expect(res.data.outcome).toBe('created');
    expect(res.data.method).toBe('structured');
    expect(res.data.job).toMatchObject({ title: 'Senior Analyst, Transaction Services', companyName: 'Northwind Capital', city: 'Luxembourg', country: 'LU', contractType: 'cdi', seniority: 'senior', yearsMin: 3, yearsMax: 5, language: 'en', stage: 'new' });
    expect(res.data.job.canonicalUrl).toBe('https://careers.northwind.example/jobs/4471');
    jobId = res.data.job.id;
    // L'analyse est mise en file une seule fois.
    const queued = await t.ctx.db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.type, 'job.qualify')));
    expect(queued).toHaveLength(1);
    expect(t.kicks.count).toBeGreaterThan(0);
  });

  it('ne relit pas la page et ne crée rien quand l’adresse est déjà connue', async () => {
    const before = requests.length;
    const res = await api.post('/api/jobs', { url: 'https://www.careers.northwind.example/jobs/4471/?ref=newsletter' });
    expect(res.status).toBe(200);
    expect(res.data.outcome).toBe('duplicate');
    expect(res.data.verdict).toMatchObject({ exists: true, match: 'url', alreadyApplied: false });
    expect(res.data.job.id).toBe(jobId);
    expect(requests.length).toBe(before);
    expect(await t.ctx.db.select().from(jobs).where(eq(jobs.userId, userId))).toHaveLength(1);
  });

  it('reconnaît la même offre collée depuis une autre plateforme', async () => {
    const res = await api.post('/api/jobs', { text: DESCRIPTION, company: 'NORTHWIND CAPITAL S.A.', title: 'Senior Analyst, Transaction Services (M/F)', location: 'Luxembourg, Luxembourg' });
    expect(res.status).toBe(200);
    expect(res.data.outcome).toBe('duplicate');
    expect(res.data.verdict.match).toBe('fingerprint');
    expect(await t.ctx.db.select().from(jobs).where(eq(jobs.userId, userId))).toHaveLength(1);
  });

  it('refuse proprement une page protégée, sans contournement', async () => {
    const blocked = await api.post('/api/jobs', { url: 'https://blocked.example/job/1' });
    expect(blocked.status).toBe(422);
    expect(blocked.data.error.code).toBe('page_unreadable');
    expect(blocked.data.error.message).toContain('Collez le texte');
    const robots = await api.post('/api/jobs', { url: 'https://closed.example/job/1' });
    expect(robots.status).toBe(422);
    expect(robots.data.error.details.kind).toBe('robots');
    // La page interdite par robots.txt n'a jamais été demandée.
    expect(requests.filter((r) => r.includes('closed.example') && !r.endsWith('/robots.txt'))).toHaveLength(0);
    const empty = await api.post('/api/jobs', { url: 'https://empty.example/x' });
    expect(empty.status).toBe(422);
  });

  it('refuse les adresses internes', async () => {
    for (const url of ['http://localhost:4000/api/settings', 'http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://10.0.0.5/x']) {
      const res = await api.post('/api/jobs', { url });
      expect(res.status).toBe(422);
      expect(res.data.error.details.kind).toBe('forbidden_target');
    }
    expect(requests.some((r) => /localhost|127\.0\.0\.1|169\.254|10\.0\.0\.5/.test(r))).toBe(false);
  });

  it('extrait l’intitulé et l’entreprise d’un texte collé', async () => {
    const text = `Financial Controller at Brightwater Energy\n\n${'We are looking for a controller to own monthly closing, reporting and budgeting for our European entities. '.repeat(4)}\nBased in Madrid, Spain.`;
    const res = await api.post('/api/jobs', { text });
    expect(res.status).toBe(201);
    expect(res.data.job).toMatchObject({ title: 'Financial Controller', companyName: 'Brightwater Energy' });
  });

  it('demande de compléter quand rien n’est lisible', async () => {
    const res = await api.post('/api/jobs', { text: 'x'.repeat(50) + ' ' + 'Un texte sans structure qui décrit vaguement une mission. '.repeat(5) + '.' });
    expect(res.status).toBe(422);
    expect(res.data.error.code).toBe('fields_missing');
  });

  it('liste les offres avec leurs compteurs et sans le texte intégral', async () => {
    const res = await api.get('/api/jobs?sort=recent');
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(2);
    expect(res.data.counts.new).toBe(2);
    expect(res.data.items[0].descriptionText).toBeUndefined();
    const search = await api.get('/api/jobs?q=northwind');
    expect(search.data.items).toHaveLength(1);
    const detail = await api.get(`/api/jobs/${jobId}`);
    expect(detail.data.job.descriptionText).toContain('due diligence');
    expect(detail.data.sightings).toHaveLength(1);
    expect(detail.data.sightings[0].sourceType).toBe('manual');
    expect(detail.data.history[0]).toMatchObject({ toStage: 'new', actor: 'user' });
  });

  it('isole les offres de chaque utilisateur', async () => {
    const other = await api.post('/api/admin/users', { email: 'second@example.test', password: 'un-autre-mot-de-passe-long', name: 'Autre' });
    expect(other.status).toBe(200);
    const verdictForOther = await checkExistingJob(forUser(t.ctx, other.data.user.id), normalizeJob({ url: 'https://careers.northwind.example/jobs/4471', company: 'Northwind Capital', title: 'Senior Analyst, Transaction Services', location: 'Luxembourg' }));
    expect(verdictForOther.exists).toBe(false);
  });
});

describe('CHECK_EXISTING_JOB', () => {
  const base = { company: 'Hartwell & Associés', title: 'Consultant Transaction Services (H/F)', location: 'Paris, France' };
  const text = (n: number) => `Au sein de l'équipe Transaction Services, vous participez à des missions de due diligence financière. ${'Vous analysez la performance historique, la dette nette et le besoin en fonds de roulement des sociétés cibles. '.repeat(n)}`;
  let source: typeof sources.$inferSelect;
  let first = '';

  beforeAll(async () => {
    source = await manualSource(uctx());
    const res = await ingestJob(uctx(), { ...base, url: 'https://jobs.lever.co/hartwell/11111111-2222-3333-4444-555555555555', descriptionText: text(3) }, { source, actor: 'system' });
    expect(res.outcome).toBe('created');
    first = res.job.id;
  });

  it('retrouve l’offre par sa référence de plateforme, même via une autre adresse', async () => {
    const v = await checkExistingJob(uctx(), normalizeJob({ company: 'Hartwell', title: 'Autre intitulé', url: 'https://jobs.lever.co/hartwell/11111111-2222-3333-4444-555555555555/apply?lever-source=Indeed' }));
    expect(v).toMatchObject({ exists: true, match: 'url' });
    expect(v.job!.id).toBe(first);
  });

  it('rattache une seconde diffusion à la fiche existante et compte les sources', async () => {
    const [board] = await t.ctx.db.insert(sources).values({ id: newId('src'), userId, type: 'adzuna', name: 'Adzuna FR', config: {} }).returning();
    const res = await ingestJob(uctx(), { company: 'HARTWELL ET ASSOCIES', title: 'Consultant Transaction Services F/H - Paris', location: 'Paris (75)', externalId: 'adz-991', url: 'https://www.adzuna.fr/details/991?se=abc', descriptionText: text(3) }, { source: board!, runId: 'run_1' });
    expect(res.outcome).toBe('updated');
    expect(res.job.id).toBe(first);
    expect(res.job.sourcesCount).toBe(2);
    expect(await t.ctx.db.select().from(jobSightings).where(eq(jobSightings.jobId, first))).toHaveLength(2);
    // Une nouvelle collecte de la même source ne crée ni fiche ni observation.
    const again = await ingestJob(uctx(), { company: 'HARTWELL ET ASSOCIES', title: 'Consultant Transaction Services F/H - Paris', location: 'Paris (75)', externalId: 'adz-991', url: 'https://www.adzuna.fr/details/991?se=def', descriptionText: text(3) }, { source: board!, runId: 'run_2' });
    expect(again.outcome).toBe('duplicate');
    expect(await t.ctx.db.select().from(jobSightings).where(eq(jobSightings.jobId, first))).toHaveLength(2);
  });

  it('ne fusionne pas deux postes distincts de la même entreprise', async () => {
    const res = await ingestJob(uctx(), { company: 'Hartwell & Associés', title: 'Auditeur financier senior (H/F)', location: 'Paris', descriptionText: "Vous intervenez sur des missions d'audit légal et contractuel auprès de groupes cotés. " + 'Vous encadrez une équipe de trois auditeurs juniors. '.repeat(4) }, { source });
    expect(res.outcome).toBe('created');
    const lyon = await ingestJob(uctx(), { ...base, location: 'Lyon', descriptionText: text(3) }, { source });
    expect(lyon.outcome).toBe('created');
  });

  it('signale un doublon possible sans fusionner', async () => {
    const res = await ingestJob(uctx(), { company: 'Hartwell & Associés', title: 'Consultant en Transaction Services', location: 'Paris', descriptionText: "Poste ouvert dans l'équipe restructuring : vous accompagnez des entreprises en difficulté dans leurs plans de financement. ".repeat(3) }, { source });
    expect(res.outcome).toBe('created');
    const dups = (res.job.flags as any).possibleDuplicates;
    expect(dups?.[0]?.id).toBe(first);
    const cleared = await api.post(`/api/jobs/${res.job.id}/not-duplicate`);
    expect(cleared.data.job.flags.possibleDuplicates).toBeUndefined();
    // Fusion décidée par l'utilisateur : les observations suivent.
    const merged = await api.post(`/api/jobs/${first}/merge`, { duplicateId: res.job.id });
    expect(merged.status).toBe(200);
    expect(await t.ctx.db.select().from(jobs).where(eq(jobs.id, res.job.id))).toHaveLength(0);
  });

  it('interdit de repostuler : une candidature partie est signalée quelle que soit la source', async () => {
    for (const to of ['to_analyze', 'analyzed', 'cv_in_progress', 'ready_to_apply', 'sent'] as const) await setStage(uctx(), first, to, { actor: 'system' });
    const v = await checkExistingJob(uctx(), normalizeJob({ company: 'Hartwell et Associés', title: 'Consultant Transaction Services', location: 'Paris La Défense', descriptionText: text(2) }));
    expect(v.exists).toBe(true);
    expect(v.alreadyApplied).toBe(true);
    expect(v.summary).toContain('Candidature déjà partie');
    const check = await api.post('/api/jobs/check', { company: 'Hartwell & Associés', title: 'Consultant Transaction Services H/F', location: 'Paris' });
    expect(check.data).toMatchObject({ exists: true, alreadyApplied: true });
    // Une offre avec candidature ne peut être ni supprimée ni ramenée en arrière.
    expect((await api.del(`/api/jobs/${first}`)).status).toBe(409);
    expect((await api.post(`/api/jobs/${first}/stage`, { to: 'to_analyze' })).status).toBe(409);
    const history = await t.ctx.db.select().from(stageHistory).where(eq(stageHistory.jobId, first));
    expect(history.map((h) => h.toStage)).toEqual(['new', 'to_analyze', 'analyzed', 'cv_in_progress', 'ready_to_apply', 'sent']);
  });

  it('conserve le texte le plus complet et signale une annonce modifiée', async () => {
    const res = await ingestJob(uctx(), { company: 'Solène Conseil', title: 'Analyste FP&A', location: 'Nantes', url: 'https://solene.example/jobs/7', descriptionText: 'Vous préparez le budget et les reportings mensuels du groupe. '.repeat(3) }, { source });
    const longer = await ingestJob(uctx(), { company: 'Solène Conseil', title: 'Analyste FP&A', location: 'Nantes', url: 'https://solene.example/jobs/7', descriptionText: 'Vous préparez le budget et les reportings mensuels du groupe. '.repeat(3) + 'Vous animez les revues de performance avec les directions opérationnelles et proposez des plans d’action. '.repeat(2) }, { source });
    expect(longer.job.id).toBe(res.job.id);
    expect(longer.job.descriptionText).toContain('revues de performance');
    const changed = await ingestJob(uctx(), { company: 'Solène Conseil', title: 'Analyste FP&A', location: 'Nantes', url: 'https://solene.example/jobs/7', descriptionText: 'Le poste évolue : vous prenez en charge la consolidation statutaire, les liasses IFRS et la relation avec les commissaires aux comptes. '.repeat(4) }, { source });
    expect(changed.contentChanged).toBe(true);
    expect((changed.job.flags as any).contentChangedAt).toBeTruthy();
  });
});
