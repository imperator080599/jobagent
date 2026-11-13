import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, makeTestEnv, signedIn, type TestEnv } from '../helpers.js';
import { setSecret } from '../../src/core/secrets.js';
import { setSetting } from '../../src/core/settings.js';
import { forUser } from '../../src/core/context.js';
import { getCurrentMaster } from '../../src/profile/cv.js';
import { diffProfile, sameCompany } from '../../src/profile/linkedin/diff.js';
import { fetchDmaSnapshot } from '../../src/profile/linkedin/dma.js';
import { csvToRecords, parseCsv, readLinkedinExport, recordsToProfile } from '../../src/profile/linkedin/records.js';
import { syncLinkedinApi } from '../../src/profile/linkedin/service.js';
import { parseCvHeuristic } from '../../src/profile/cv-parse.js';
import { schedulerTick } from '../../src/pipeline/scheduler.js';
import { runWorker } from '../../src/pipeline/worker.js';

const CV_TEXT = readFileSync('tests/fixtures/cv/camille-durand.txt', 'utf8');

// Archive LinkedIn fictive, au format de l'export officiel. Écarts volontaires avec le CV :
// nouvelle expérience, date de début différente, compétences et certification supplémentaires.
const EXPORT = {
  'Profile.csv': 'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\nCamille,Durand,,,,"Auditrice senior | US GAAP, PCAOB","Auditrice financière, en évolution vers le conseil en transactions.",Accounting,75001,"Paris, Île-de-France, France",,,\n',
  'Positions.csv':
    'Company Name,Title,Description,Location,Started On,Finished On\n' +
    'Cabinet Valmont,Consultante Transaction Services,"Due diligence financière côté acquéreur pour des fonds d\'investissement.","Paris, France",Jan 2025,\n' +
    'Hartwell & Associés,Auditrice senior,"Audit des comptes consolidés de filiales de groupes américains cotés.\n• Coordination de l\'intervention de spécialistes en évaluation et en fiscalité sur trois dossiers de la saison.","Paris La Défense",Oct 2021,Dec 2024\n' +
    'Belmont Audit,Auditrice junior,,Lyon,Jan 2021,Jun 2021\n',
  'Education.csv': 'School Name,Start Date,End Date,Notes,Degree Name,Activities\nInstitut Supérieur de Gestion de Lyon,2017,2021,,Master Programme Grande École,\n',
  'Skills.csv': 'Name\nUS GAAP\nAudit financier\nPower BI\nModélisation financière\n',
  'Languages.csv': 'Name,Proficiency\nFrench,Native or bilingual proficiency\nEnglish,Full professional proficiency\nGerman,Elementary proficiency\n',
  'Certifications.csv': 'Name,Url,Authority,Started On,Finished On,License Number\nCFA Level I,,CFA Institute,Jun 2024,,\nCertification AMF,,AMF,2021,,\n',
  'Email Addresses.csv': 'Email Address,Confirmed,Primary,Updated On\ncamille.durand@example.test,Yes,Yes,1/1/24\n',
  // Fichiers privés présents dans une vraie archive : ils ne doivent jamais être lus.
  'messages.csv': 'CONVERSATION ID,FROM,CONTENT\n1,Quelqu\'un,Message privé\n',
  'Connections.csv': 'First Name,Last Name\nJean,Tiers\n',
};
const exportZip = () => zipSync(Object.fromEntries(Object.entries(EXPORT).map(([k, v]) => [k, strToU8(v)])));

describe('lecture des données LinkedIn', () => {
  it('analyse le CSV avec guillemets, virgules et retours à la ligne dans les champs', () => {
    expect(parseCsv('a,b\n"x, y","ligne 1\nligne 2"\n"il a dit ""oui""",z\n')).toEqual([['a', 'b'], ['x, y', 'ligne 1\nligne 2'], ['il a dit "oui"', 'z']]);
    expect(csvToRecords('Notes:\n"Préambule de LinkedIn"\n\nName,Proficiency\nFrench,Native\n', 'Name')).toEqual([{ Name: 'French', Proficiency: 'Native' }]);
  });

  it('ne lit que les fichiers de profil de l’archive', () => {
    const records = readLinkedinExport(exportZip());
    expect(Object.keys(records).sort()).toEqual(['CERTIFICATIONS', 'EDUCATION', 'EMAIL_ADDRESSES', 'LANGUAGES', 'POSITIONS', 'PROFILE', 'SKILLS']);
    const profile = recordsToProfile(records);
    expect(profile.identity).toMatchObject({ fullName: 'Camille Durand', email: 'camille.durand@example.test', location: 'Paris, Île-de-France, France' });
    expect(profile.experiences.map((e) => [e.company, e.start, e.end])).toEqual([
      ['Cabinet Valmont', '2025-01', 'present'],
      ['Hartwell & Associés', '2021-10', '2024-12'],
      ['Belmont Audit', '2021-01', '2021-06'],
    ]);
    expect(profile.experiences[1]!.bullets).toHaveLength(2);
    expect(JSON.stringify(profile)).not.toContain('Message privé');
    expect(JSON.stringify(profile)).not.toContain('Tiers');
  });

  it('rapproche les noms d’entreprise malgré les variantes', () => {
    expect(sameCompany('Hartwell & Associés', 'Hartwell et Associés SAS')).toBe(true);
    expect(sameCompany('Mazars', 'Mazars France')).toBe(true);
    expect(sameCompany('Belmont Audit', 'Cabinet Valmont')).toBe(false);
  });
});

describe('comparaison LinkedIn ↔ CV master', () => {
  const master = parseCvHeuristic(CV_TEXT);
  const li = recordsToProfile(readLinkedinExport(exportZip()));
  const diffs = diffProfile(master, li);
  const kinds = diffs.map((d) => d.kind);

  it('détecte expériences manquantes, dates incohérentes, missions, compétences et certifications nouvelles', () => {
    expect(kinds.filter((k) => k === 'experience_missing_in_cv')).toHaveLength(1);
    expect(diffs.find((d) => d.kind === 'experience_missing_in_cv')!.summary).toContain('Cabinet Valmont');
    // Orangina Distribution figure sur le CV mais pas sur LinkedIn.
    expect(diffs.find((d) => d.kind === 'experience_missing_in_linkedin')!.summary).toContain('Orangina Distribution');
    const dates = diffs.filter((d) => d.kind === 'date_mismatch').map((d) => [d.cvValue, d.linkedinValue]);
    expect(dates).toEqual([['2021-09', '2021-10'], ['present', '2024-12']]);
    expect(diffs.find((d) => d.kind === 'new_skills')!.linkedinValue).toEqual(['Power BI', 'Modélisation financière']);
    expect(diffs.find((d) => d.kind === 'certification_missing_in_cv')!.summary).toContain('CFA Level I');
    expect(diffs.find((d) => d.kind === 'language_missing_in_cv')!.summary).toContain('German');
    expect(diffs.find((d) => d.kind === 'new_responsibilities')!.linkedinValue).toEqual(["Coordination de l'intervention de spécialistes en évaluation et en fiscalité sur trois dossiers de la saison."]);
  });

  it('ignore ce qui est identique ou simplement formulé autrement', () => {
    // Même intitulé à la parenthèse près, même certification, mêmes langues (français/French, anglais/English).
    expect(kinds).not.toContain('title_mismatch');
    expect(diffs.some((d) => d.summary.includes('Certification AMF'))).toBe(false);
    expect(kinds).not.toContain('language_level_mismatch');
    expect(kinds).not.toContain('education_missing_in_cv');
    expect(diffProfile(master, master).filter((d) => d.proposal)).toEqual([]);
  });
});

describe('API officielle de portabilité', () => {
  it('pagine jusqu’à épuisement et envoie la version exigée', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      const u = new URL(String(url));
      const domain = u.searchParams.get('domain');
      const start = Number(u.searchParams.get('start'));
      if (domain === 'SKILLS' && start === 0) return Response.json({ paging: { start: 0, count: 10, links: [{ rel: 'next', href: 'x' }] }, elements: [{ snapshotDomain: 'SKILLS', snapshotData: [{ Name: 'Excel' }] }] });
      if (domain === 'SKILLS' && start === 1) return Response.json({ paging: { start: 1, count: 10, links: [] }, elements: [{ snapshotDomain: 'SKILLS', snapshotData: [{ Name: 'SAP' }] }] });
      if (domain === 'PROFILE') return Response.json({ paging: { links: [] }, elements: [{ snapshotDomain: 'PROFILE', snapshotData: [{ 'First Name': 'Camille', 'Last Name': 'Durand', Headline: 'Auditrice' }] }] });
      return new Response('{"message":"No data found for this memberId"}', { status: 404 });
    }) as typeof globalThis.fetch;
    const records = await fetchDmaSnapshot({ fetch, log: { warn() {}, info() {}, error() {}, debug() {}, child() { return this as any; } } }, 'jeton', ['PROFILE', 'SKILLS', 'POSITIONS']);
    expect(records.SKILLS).toEqual([{ Name: 'Excel' }, { Name: 'SAP' }]);
    expect(records.POSITIONS).toBeUndefined();
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer jeton', 'Linkedin-Version': '202312' });
    expect(calls.every((c) => c.url.startsWith('https://api.linkedin.com/rest/memberSnapshotData?q=criteria'))).toBe(true);
  });
});

describe('synchronisation et arbitrage', () => {
  let t: TestEnv;
  let api: ReturnType<typeof client>;
  let userId: string;
  let apiMode: 'ok' | 'expired' = 'ok';

  beforeAll(async () => {
    t = await makeTestEnv({
      fetch: (url) => {
        if (apiMode === 'expired') return new Response('{}', { status: 401 });
        const domain = new URL(url).searchParams.get('domain')!;
        const file = { PROFILE: 'Profile.csv', POSITIONS: 'Positions.csv', EDUCATION: 'Education.csv', SKILLS: 'Skills.csv', LANGUAGES: 'Languages.csv', CERTIFICATIONS: 'Certifications.csv' }[domain] as keyof typeof EXPORT | undefined;
        const header = { PROFILE: 'First Name', POSITIONS: 'Company Name', EDUCATION: 'School Name', SKILLS: 'Name', LANGUAGES: 'Name', CERTIFICATIONS: 'Name' }[domain];
        if (!file) return new Response('No data found for this memberId', { status: 404 });
        return Response.json({ paging: { links: [] }, elements: [{ snapshotDomain: domain, snapshotData: csvToRecords(EXPORT[file], header!) }] });
      },
    });
    ({ api, userId } = await signedIn(t));
    const imp = await api.post('/api/profile/cv/import-text', { text: CV_TEXT });
    await api.post(`/api/profile/cv/${imp.data.cv.id}/approve`);
  });
  afterAll(async () => {
    await t.close();
  });

  const upload = () => {
    const form = new FormData();
    form.set('file', new File([exportZip()], 'Basic_LinkedInDataExport.zip', { type: 'application/zip' }));
    return api.post('/api/profile/linkedin/import', form);
  };

  it('importe l’archive, enregistre les écarts et crée une seule demande groupée', async () => {
    const res = await upload();
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ changed: true, autoApplied: 0 });
    expect(res.data.newDiffs).toBeGreaterThanOrEqual(7);
    const state = await api.get('/api/profile/linkedin');
    expect(state.data.snapshot).toMatchObject({ method: 'export_zip', experiences: 3 });
    const inbox = (await api.get('/api/inbox')).data.items.filter((i: any) => i.type === 'linkedin.diffs');
    expect(inbox).toHaveLength(1);
    // Le master n'a pas bougé.
    expect((await getCurrentMaster(t.ctx.db, userId))!.data.experiences).toHaveLength(3);
  });

  it('ne signale rien quand le profil n’a pas changé', async () => {
    const res = await upload();
    expect(res.data).toMatchObject({ changed: false, newDiffs: 0 });
  });

  it('reporte un écart accepté dans un brouillon, sans toucher au master tant qu’il n’est pas validé', async () => {
    const diffs = (await api.get('/api/profile/linkedin')).data.diffs;
    const missing = diffs.find((d: any) => d.kind === 'experience_missing_in_cv');
    const skills = diffs.find((d: any) => d.kind === 'new_skills');
    const date = diffs.find((d: any) => d.kind === 'date_mismatch' && d.cvValue === '2021-09');

    const a = await api.post(`/api/profile/linkedin/diffs/${missing.id}`, { decision: 'accept' });
    // Compétences : l'utilisateur ne retient que celle qu'il possède réellement.
    const b = await api.post(`/api/profile/linkedin/diffs/${skills.id}`, { decision: 'accept', selected: ['Modélisation financière'] });
    expect(b.data.draftId).toBe(a.data.draftId);
    await api.post(`/api/profile/linkedin/diffs/${date.id}`, { decision: 'reject' });

    const master = await getCurrentMaster(t.ctx.db, userId);
    expect(master!.data.experiences).toHaveLength(3);
    const draft = (await api.get(`/api/profile/cv/${a.data.draftId}`)).data.cv;
    expect(draft).toMatchObject({ status: 'draft', source: 'linkedin', parentId: master!.id });
    expect(draft.data.experiences[0]).toMatchObject({ company: 'Cabinet Valmont', title: 'Consultante Transaction Services' });
    expect(draft.data.skills.at(-1).items).toContain('Modélisation financière');
    expect(draft.data.skills.at(-1).items).not.toContain('Power BI');
    expect(draft.changeSummary).toContain('Cabinet Valmont');
    expect(draft.data.experiences.find((e: any) => e.company === 'Hartwell & Associés').start).toBe('2021-09');

    await api.post(`/api/profile/cv/${draft.id}/approve`);
    expect((await getCurrentMaster(t.ctx.db, userId))!.data.experiences).toHaveLength(4);
  });

  it('ne repose jamais une question déjà tranchée', async () => {
    const before = (await api.get('/api/profile/linkedin')).data;
    expect(before.history.some((d: any) => d.kind === 'date_mismatch' && d.status === 'rejected')).toBe(true);
    // Nouvelle synchronisation (profil modifié à la marge) : l'écart refusé ne revient pas.
    const form = new FormData();
    const modified = { ...EXPORT, 'Skills.csv': `${EXPORT['Skills.csv']}Consolidation\n` };
    form.set('file', new File([zipSync(Object.fromEntries(Object.entries(modified).map(([k, v]) => [k, strToU8(v)])))], 'export.zip'));
    const res = await api.post('/api/profile/linkedin/import', form);
    expect(res.data.changed).toBe(true);
    const after = (await api.get('/api/profile/linkedin')).data.diffs;
    expect(after.some((d: any) => d.kind === 'date_mismatch' && d.cvValue === '2021-09')).toBe(false);
    expect(after.some((d: any) => d.kind === 'experience_missing_in_cv')).toBe(false);
  });

  it('synchronise par l’API officielle selon la planification, et signale un jeton expiré', async () => {
    const uctx = forUser(t.ctx, userId);
    await expect(syncLinkedinApi(uctx)).rejects.toThrow(/Aucun jeton/);
    await setSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'linkedin_access_token', 'jeton-test');
    const res = await syncLinkedinApi(uctx);
    expect(res.snapshot.method).toBe('dma_api');

    await setSetting(t.ctx.db, userId, 'linkedin.sync', { enabled: true, intervalDays: 7 });
    expect((await schedulerTick(t.ctx)).started).toContain(`linkedin.sync:${userId}`);
    expect((await runWorker(t.ctx, { budgetMs: 10_000, workerId: 'w', types: ['linkedin.sync'] })).processed).toBe(1);
    // Pas de nouvelle exécution avant l'intervalle configuré.
    expect((await schedulerTick(t.ctx)).started).not.toContain(`linkedin.sync:${userId}`);
    t.clock.advance(8 * 86400_000);
    apiMode = 'expired';
    expect((await schedulerTick(t.ctx)).started).toContain(`linkedin.sync:${userId}`);
    const w = await runWorker(t.ctx, { budgetMs: 10_000, workerId: 'w', types: ['linkedin.sync'] });
    expect(w).toMatchObject({ processed: 1, blocked: 1 });
  });

  it('n’applique automatiquement que les ajouts factuels, et seulement si l’utilisateur l’a autorisé', async () => {
    const other = await makeTestEnv();
    const s = await signedIn(other);
    const imp = await s.api.post('/api/profile/cv/import-text', { text: CV_TEXT });
    await s.api.post(`/api/profile/cv/${imp.data.cv.id}/approve`);
    await setSetting(other.ctx.db, s.userId, 'linkedin.sync', { autoApplyFactual: true });
    const form = new FormData();
    form.set('file', new File([exportZip()], 'export.zip'));
    const res = await s.api.post('/api/profile/linkedin/import', form);
    expect(res.data.autoApplied).toBe(3); // expérience, certification, langue
    const master = await getCurrentMaster(other.ctx.db, s.userId);
    expect(master!.data.experiences.some((e) => e.company === 'Cabinet Valmont')).toBe(true);
    expect(master!.data.certifications.some((c) => c.name === 'CFA Level I')).toBe(true);
    // Les contradictions (dates) restent soumises à l'utilisateur.
    expect(master!.data.experiences.find((e) => e.company === 'Hartwell & Associés')!.start).toBe('2021-09');
    const open = (await s.api.get('/api/profile/linkedin')).data.diffs;
    expect(open.some((d: any) => d.kind === 'date_mismatch')).toBe(true);
    const log = (await s.api.get('/api/settings/activity')).data.items;
    expect(log.some((i: any) => i.action === 'linkedin.auto_applied')).toBe(true);
    await other.close();
  });
});
