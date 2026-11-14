// Élargissement des sources : nouveaux sites carrières (Personio, Breezy, Workable,
// Recruitee, Workday), annuaire d'employeurs et découverte de leurs sites, sens
// descendant (offre → entreprise → site complet), matrice de couverture, synonymes
// trilingues, alertes VIE. Réseau simulé : formes de réponse réelles, contenus fictifs.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeTestEnv, signedIn, type FetchMock, type TestEnv } from '../helpers.js';
import { forUser } from '../../src/core/context.js';
import { newId } from '../../src/db/ids.js';
import { companies, jobs, sources } from '../../src/db/schema.js';
import { detectConnector } from '../../src/search/connectors/index.js';
import { runSource } from '../../src/search/engine.js';
import { resetHttpCaches } from '../../src/search/http.js';
import { discoverCompany, seedTargetCompanies, slugCandidates, TARGET_SEED } from '../../src/search/companies.js';
import { coverageMatrix } from '../../src/search/coverage.js';
import { expandTitles } from '../../src/search/synonyms.js';
import { parseAlert } from '../../src/tracker/mail.js';

const desc = (t: string) => `<p>${t}</p><p>${'Due diligence financière, qualité des résultats, dette nette et besoin en fonds de roulement pour des fonds d’investissement. '.repeat(5)}</p>`;
const requests: { url: string; method: string; body?: string }[] = [];

// Forme réelle du flux XML Personio (vérifiée sur un site public), contenu fictif.
const personioXml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>3100001</id>
    <office>Luxembourg</office>
    <department>Deal Advisory</department>
    <name>Senior Associate Transaction Services (m/f/d)</name>
    <jobDescriptions>
        <jobDescription>
            <name>Your role at Kestrel &amp; Partners</name>
            <value><![CDATA[${desc('Buy-side and sell-side financial due diligence.')}]]></value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>experienced</seniority>
    <createdAt>2026-11-10T09:00:00+00:00</createdAt>
</position>
<position>
    <id>3100002</id>
    <office>Luxembourg</office>
    <department>Operations</department>
    <name>Office Manager (m/f/d)</name>
    <jobDescriptions></jobDescriptions>
    <employmentType>permanent</employmentType>
    <createdAt>2026-11-09T09:00:00+00:00</createdAt>
</position>
</workzag-jobs>`;

let offline = false;
const net: FetchMock = (url, init) => {
  const u = new URL(url);
  if (offline) throw new Error('getaddrinfo ENOTFOUND');
  requests.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (u.host === 'kestrel.jobs.personio.de' && u.pathname === '/xml') return new Response(personioXml, { status: 200, headers: { 'content-type': 'text/xml' } });
  if (u.host === 'harrow.breezy.hr' && u.pathname === '/json')
    return json([{ id: 'b1', friendly_id: 'b1-valuation-analyst', name: 'Valuation Analyst', url: 'https://harrow.breezy.hr/p/b1-valuation-analyst', published_date: '2026-11-08T10:00:00.000Z', type: { id: 'fullTime', name: 'Full-Time' }, location: { country: { name: 'France', id: 'FR' }, city: 'Paris', is_remote: false, name: 'Paris, FR' }, department: 'Valuation', company: { name: 'Harrow Valuation', friendly_id: 'harrow' } }]);
  if (u.host === 'apply.workable.com' && u.pathname === '/api/v1/widget/accounts/quayside')
    return json({ name: 'Quayside Capital', jobs: [{ title: 'M&A Analyst', shortcode: 'QS1', employment_type: 'Full-time', telecommuting: false, department: 'Corporate Finance', url: 'https://apply.workable.com/quayside/j/QS1/', application_url: 'https://apply.workable.com/quayside/j/QS1/apply/', published_on: '2026-11-07', country: 'France', city: 'Paris', description: desc('M&A execution for mid-cap clients.'), locations: [{ country: 'France', countryCode: 'FR', city: 'Paris' }] }] });
  if (u.host === 'norden.recruitee.com' && u.pathname === '/api/offers/')
    return json({ offers: [{ id: 501, slug: 'corporate-finance-associate', title: 'Corporate Finance Associate', description: desc('Corporate finance advisory.'), requirements: '<p>3+ years</p>', location: 'Paris, France', city: 'Paris', country_code: 'FR', careers_url: 'https://norden.recruitee.com/o/corporate-finance-associate', careers_apply_url: 'https://norden.recruitee.com/o/corporate-finance-associate/c/new', published_at: '2026-11-06 10:00:00 UTC', employment_type_code: 'fulltime_permanent', department: 'Corporate Finance' }] });
  if (u.host === 'vantage.wd3.myworkdayjobs.com' && u.pathname === '/wday/cxs/vantage/External/jobs') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { offset: number; searchText: string };
    if (!/transaction/i.test(body.searchText)) return json({ total: 0, jobPostings: [] });
    const all = Array.from({ length: 25 }, (_, i) => ({ title: i === 0 ? 'Transaction Services Senior Consultant' : `Transaction Services Analyst ${i}`, externalPath: `/job/Paris/TS-${i}_R${1000 + i}`, locationsText: 'Paris', postedOn: 'Posted 2 Days Ago', bulletFields: [`R${1000 + i}`] }));
    return json({ total: all.length, jobPostings: all.slice(body.offset, body.offset + 20) });
  }
  if (u.host === 'vantage.wd3.myworkdayjobs.com' && u.pathname.startsWith('/wday/cxs/vantage/External/job/')) return json({ jobPostingInfo: { title: 'Transaction Services Senior Consultant', jobDescription: desc('Financial due diligence.'), location: 'Paris', externalUrl: 'https://vantage.wd3.myworkdayjobs.com/External/job/Paris/TS-0_R1000', jobReqId: 'R1000' } });
  // Découverte : API publiques de lecture des ATS.
  if (u.host === 'boards-api.greenhouse.io') {
    if (u.pathname === '/v1/boards/eightadvisory') return json({ name: 'Eight Advisory', content: '' });
    if (u.pathname === '/v1/boards/eightadvisory/jobs') return json({ jobs: [], meta: { total: 12 } });
    return json({ status: 404, error: 'Job not found' }, 404);
  }
  if (u.host === 'api.lever.co') return u.pathname === '/v0/postings/accuracy' ? json([{ id: 'x' }]) : json({ ok: false, error: 'Document not found' }, 404);
  if (u.host === 'api.ashbyhq.com' || u.host === 'api.smartrecruiters.com') return json({}, 404);
  if (u.host.endsWith('.jobs.personio.de') || u.host.endsWith('.breezy.hr') || u.host.endsWith('.recruitee.com')) return new Response('Not found', { status: 404 });
  return new Response('not found', { status: 404 });
};

let t: TestEnv;
let api: Awaited<ReturnType<typeof signedIn>>['api'];
let userId: string;
const uctx = () => forUser(t.ctx, userId);
const addSource = async (type: string, name: string, config: Record<string, unknown>) => (await t.ctx.db.insert(sources).values({ id: newId('src'), userId, type, name, config }).returning())[0]!;
const jobsOf = async (sourceName: string) => (await t.ctx.db.select().from(jobs).where(eq(jobs.userId, userId))).filter((j) => j.companyName.includes(sourceName));

beforeAll(async () => {
  resetHttpCaches();
  t = await makeTestEnv({ fetch: net });
  ({ api, userId } = await signedIn(t));
  const created = await api.post('/api/search/profiles', { name: 'Transaction Services', criteria: { titles: ['Consultant Transaction Services', 'Analyste M&A', 'Valuation Analyst', 'Corporate Finance Associate'], countries: ['FR', 'LU'] } });
  expect(created.status).toBe(200);
});
afterAll(() => t.close());
beforeEach(() => {
  requests.length = 0;
});

describe('nouveaux sites carrières', () => {
  it('reconnaît leurs adresses', () => {
    expect(detectConnector('https://kestrel.jobs.personio.de/job/3100001')).toMatchObject({ connector: { type: 'personio' }, config: { company: 'kestrel', domain: 'de' } });
    expect(detectConnector('https://harrow.breezy.hr/p/b1-valuation-analyst')).toMatchObject({ connector: { type: 'breezy' }, config: { company: 'harrow' } });
    expect(detectConnector('https://apply.workable.com/quayside/j/QS1/')).toMatchObject({ connector: { type: 'workable' }, config: { account: 'quayside' } });
    expect(detectConnector('https://norden.recruitee.com/o/corporate-finance-associate')).toMatchObject({ connector: { type: 'recruitee' }, config: { company: 'norden' } });
    expect(detectConnector('https://vantage.wd3.myworkdayjobs.com/en-US/External/job/Paris/TS-0_R1000')).toMatchObject({ connector: { type: 'workday' }, config: { host: 'vantage.wd3.myworkdayjobs.com', tenant: 'vantage', site: 'External' } });
  });

  it('Personio : flux complet lu, texte intégral, seules les offres pertinentes retenues', async () => {
    const s = await addSource('personio', 'Kestrel & Partners', { company: 'kestrel', name: 'Kestrel & Partners', domain: 'de' });
    const { run } = await runSource(uctx(), s.id, { trigger: 'manual' });
    expect(run).toMatchObject({ status: 'complete', itemsSeen: 2, itemsRelevant: 1, itemsNew: 1 });
    const [job] = await jobsOf('Kestrel');
    expect(job).toMatchObject({ title: 'Senior Associate Transaction Services (m/f/d)', country: 'LU' });
    expect(job!.descriptionText).toContain('Buy-side and sell-side financial due diligence');
  });

  it('Breezy, Workable et Recruitee : offres lues et rattachées à leur entreprise', async () => {
    for (const [type, name, config] of [
      ['breezy', 'Harrow Valuation', { company: 'harrow', name: 'Harrow Valuation' }],
      ['workable', 'Quayside Capital', { account: 'quayside', name: 'Quayside Capital' }],
      ['recruitee', 'Norden Finance', { company: 'norden', name: 'Norden Finance' }],
    ] as const) {
      const s = await addSource(type, name, config);
      const { run } = await runSource(uctx(), s.id, { trigger: 'manual' });
      expect(run.status).toBe('complete');
      expect(run.itemsNew).toBe(1);
    }
    expect((await jobsOf('Quayside'))[0]).toMatchObject({ title: 'M&A Analyst', applyUrl: 'https://apply.workable.com/quayside/j/QS1/apply/' });
  });

  it('Workday : recherche par vos intitulés avec pagination, lecture signalée comme ciblée', async () => {
    const s = await addSource('workday', 'Vantage Advisory', { host: 'vantage.wd3.myworkdayjobs.com', tenant: 'vantage', site: 'External', name: 'Vantage Advisory' });
    const { run } = await runSource(uctx(), s.id, { trigger: 'manual' });
    // Lecture ciblée : jamais présentée comme complète (une offre absente n'est pas « retirée »).
    expect(run.status).toBe('partial');
    expect(run.incompleteReason).toContain('ciblée');
    const searches = requests.filter((r) => r.method === 'POST');
    expect(searches.some((r) => JSON.parse(r.body!).offset === 20)).toBe(true);
    expect(run.itemsSeen).toBe(25);
  });
});

describe('annuaire des employeurs et découverte', () => {
  it('ajoute la liste de départ sans doublon', async () => {
    const n = await seedTargetCompanies(uctx());
    expect(n).toBe(TARGET_SEED.length);
    expect(await seedTargetCompanies(uctx())).toBe(0);
    expect(slugCandidates('Eight Advisory SAS')).toEqual(expect.arrayContaining(['eightadvisory', 'eight-advisory']));
  });

  it('trouve et vérifie un site carrières, puis le met sous surveillance', async () => {
    const [co] = await t.ctx.db.select().from(companies).where(and(eq(companies.userId, userId), eq(companies.name, 'Eight Advisory')));
    const found = await discoverCompany(uctx(), co!.id);
    expect(found).toMatchObject({ discovery: 'found', ats: 'greenhouse' });
    expect(found.discoveryNote).toContain('12 offre(s)');
    const [src] = await t.ctx.db.select().from(sources).where(eq(sources.id, found.boardSourceId!));
    expect(src).toMatchObject({ type: 'greenhouse', companyId: co!.id, config: { board: 'eightadvisory', company: 'Eight Advisory' } });
  });

  it('un site dont l’entreprise ne peut pas être vérifiée reste « à confirmer » ; un site introuvable est signalé', async () => {
    const [acc] = await t.ctx.db.select().from(companies).where(and(eq(companies.userId, userId), eq(companies.name, 'Accuracy')));
    const a = await discoverCompany(uctx(), acc!.id);
    expect(a.discovery).toBe('ambiguous');
    expect(a.boardSourceId).toBeNull();
    const [laz] = await t.ctx.db.select().from(companies).where(and(eq(companies.userId, userId), eq(companies.name, 'Lazard')));
    const l = await discoverCompany(uctx(), laz!.id);
    expect(l.discovery).toBe('not_found');
    expect(l.discoveryNote).toContain('Indiquez l');
  });

  it('panne réseau : rien n’est conclu, l’entreprise sera revérifiée', async () => {
    offline = true;
    try {
      const [co] = await t.ctx.db.select().from(companies).where(and(eq(companies.userId, userId), eq(companies.name, 'Ardian')));
      const r = await discoverCompany(uctx(), co!.id);
      expect(r.discovery).toBe('unknown');
      expect(r.discoveryNote).toContain('nouvel essai');
    } finally {
      offline = false;
    }
  });

  it('sens descendant : une offre sur un ATS fait suivre tout le site carrières de son entreprise', async () => {
    const added = await api.post('/api/jobs', { url: 'https://jobs.lever.co/marlowadvisory/0000aaaa-bbbb-cccc-dddd-eeeeffff0001', title: 'Transaction Services Consultant', company: 'Marlow Advisory', location: 'Paris', text: 'Financial due diligence engagements for private equity funds, quality of earnings and net debt analysis.' });
    expect(added.status).toBe(201);
    const [co] = await t.ctx.db.select().from(companies).where(and(eq(companies.userId, userId), eq(companies.name, 'Marlow Advisory')));
    expect(co).toMatchObject({ origin: 'job', discovery: 'found', ats: 'lever', jobsSeen: 1 });
    const [src] = await t.ctx.db.select().from(sources).where(eq(sources.id, co!.boardSourceId!));
    expect(src).toMatchObject({ type: 'lever', config: { site: 'marlowadvisory', company: 'Marlow Advisory' } });
  });
});

describe('couverture, synonymes et alertes', () => {
  it('matrice : « opérationnelle » seulement après une lecture réussie ; indisponibilités justifiées', async () => {
    const m = await coverageMatrix(uctx());
    const row = (id: string) => m.rows.find((r) => r.id === id)!;
    expect(row('personio')).toMatchObject({ status: 'operational', sources: 1 });
    expect(row('ashby')).toMatchObject({ status: 'not_configured' });
    expect(row('francetravail')).toMatchObject({ status: 'unavailable' });
    expect(row('francetravail').evidence[0]?.url).toContain('data.gouv.fr');
    expect(row('alerts:linkedin')).toMatchObject({ status: 'not_configured' });
    expect(row('alerts:linkedin').evidence[0]?.url).toContain('linkedin.com/legal');
    expect(row('google_jobs').status).toBe('unavailable');
    expect(m.companies.found).toBeGreaterThanOrEqual(2);
    // La source Lever découverte n'a jamais été lue : elle n'est pas « opérationnelle ».
    expect(row('lever').status).toBe('configured_untested');
  });

  it('élargit les intitulés en français, anglais, espagnol et allemand', () => {
    const v = expandTitles(['Transaction Services'], [], 60).map((s) => s.toLowerCase());
    expect(v).toEqual(expect.arrayContaining(['financial due diligence', 'deal advisory', 'servicios de transacciones', 'due diligence financiera', 'transaktionsberatung']));
    expect(expandTitles(['Valuation'], [], 60).map((s) => s.toLowerCase())).toEqual(expect.arrayContaining(['valoración', 'unternehmensbewertung']));
  });

  it('alerte VIE de Business France : l’offre et son lien sont conservés', () => {
    const html = `<html><body><table><tr><td><a href="https://mon-vie-via.businessfrance.fr/offres/240000">VIE – Analyste M&amp;A (H/F)</a><br>Kestrel &amp; Partners · Luxembourg</td></tr></table></body></html>`;
    const found = parseAlert(html);
    expect(found[0]).toMatchObject({ url: 'https://mon-vie-via.businessfrance.fr/offres/240000' });
    expect(found[0]!.title).toContain('Analyste M&A');
  });
});
