import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_PASSWORD, client, makeTestEnv, signedIn, type TestEnv } from '../helpers.js';
import { cvVersions, files, profileFacts } from '../../src/db/schema.js';
import { DEFAULT_ATS_PROMPT } from '../../src/profile/ats-prompt.js';
import { findAnswer, recordAnswerUse, upsertAnswer } from '../../src/profile/answers.js';
import { getCurrentMaster } from '../../src/profile/cv.js';
import { getFactValue, setFact } from '../../src/profile/facts.js';

const FIXTURE = 'tests/fixtures/cv/camille-durand';
let t: TestEnv;
let api: ReturnType<typeof client>;
let userId: string;

function fileForm(path: string, name: string, type: string) {
  const form = new FormData();
  form.set('file', new File([readFileSync(path)], name, { type }));
  return form;
}

beforeAll(async () => {
  t = await makeTestEnv();
  ({ api, userId } = await signedIn(t));
});
afterAll(async () => {
  await t.close();
});

describe('initialisation du compte', () => {
  it('prépare un prompt ATS par défaut et les étapes de démarrage', async () => {
    const prompt = await api.get('/api/profile/ats-prompt');
    expect(prompt.data.active).toMatchObject({ version: 1, isDefault: true, content: DEFAULT_ATS_PROMPT });
    const inbox = await api.get('/api/inbox');
    expect(inbox.data.items.map((i: any) => i.type)).toEqual(['setup.cv_master', 'setup.ats_prompt']);
    const summary = await api.get('/api/profile/summary');
    expect(summary.data.masters).toEqual([]);
    expect(summary.data.missingFacts.length).toBeGreaterThan(5);
  });
});

describe('CV master', () => {
  let draftId: string;

  it('importe un PDF en brouillon sans rien valider automatiquement', async () => {
    const res = await api.post('/api/profile/cv/import', fileForm(`${FIXTURE}.pdf`, 'CV Camille.pdf', 'application/pdf'));
    expect(res.status).toBe(200);
    draftId = res.data.cv.id;
    expect(res.data.cv).toMatchObject({ kind: 'master', status: 'draft', isCurrent: false, language: 'fr', version: 1 });
    expect(res.data.cv.data.experiences).toHaveLength(3);
    expect(res.data.cv.checks.grounding).toEqual([]);
    expect(await getCurrentMaster(t.ctx.db, userId)).toBeNull();
    // Le fichier d'origine est conservé tel quel.
    const [stored] = await t.ctx.db.select().from(files).where(eq(files.id, res.data.cv.sourceFileId));
    expect(Buffer.from(stored!.data).equals(readFileSync(`${FIXTURE}.pdf`))).toBe(true);
    const inbox = await api.get('/api/inbox');
    expect(inbox.data.items.some((i: any) => i.type === 'cv.master.review' && i.body.cvId === draftId)).toBe(true);
  });

  it('refuse un fichier illisible ou vide', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])], 'x.bin', { type: 'application/octet-stream' }));
    expect((await api.post('/api/profile/cv/import', form)).status).toBe(400);
    expect((await api.post('/api/profile/cv/import-text', { text: 'trop court' })).status).toBe(400);
  });

  it('permet de corriger le brouillon puis de le valider comme master', async () => {
    const draft = (await api.get(`/api/profile/cv/${draftId}`)).data.cv;
    draft.data.identity.headline = 'Auditrice financière senior';
    const upd = await api.put(`/api/profile/cv/${draftId}`, { data: draft.data });
    expect(upd.data.cv.data.identity.headline).toBe('Auditrice financière senior');

    const ok = await api.post(`/api/profile/cv/${draftId}/approve`);
    expect(ok.data.cv).toMatchObject({ status: 'approved', isCurrent: true });
    const master = await getCurrentMaster(t.ctx.db, userId);
    expect(master!.id).toBe(draftId);
    // Les demandes correspondantes sont closes.
    const inbox = await api.get('/api/inbox');
    expect(inbox.data.items.map((i: any) => i.type)).toEqual(['setup.ats_prompt']);
  });

  it('rend le master validé immuable', async () => {
    const master = (await api.get(`/api/profile/cv/${draftId}`)).data.cv;
    master.data.experiences[0].title = 'Directrice associée';
    expect((await api.put(`/api/profile/cv/${draftId}`, { data: master.data })).status).toBe(409);
    expect((await api.del(`/api/profile/cv/${draftId}`)).status).toBe(409);
    const [row] = await t.ctx.db.select().from(cvVersions).where(eq(cvVersions.id, draftId));
    expect(row!.data.experiences[0]!.title).toBe('Auditrice senior (Senior 2)');
  });

  it('alimente le référentiel depuis le CV validé, avec sa source', async () => {
    expect(await getFactValue(t.ctx.db, userId, 'contact.first_name')).toBe('Camille');
    expect(await getFactValue(t.ctx.db, userId, 'contact.last_name')).toBe('DURAND');
    expect(await getFactValue(t.ctx.db, userId, 'contact.email')).toBe('camille.durand@example.test');
    expect(await getFactValue(t.ctx.db, userId, 'background.current_employer')).toBe('Hartwell & Associés');
    const [f] = await t.ctx.db.select().from(profileFacts).where(and(eq(profileFacts.userId, userId), eq(profileFacts.key, 'contact.email')));
    expect(f).toMatchObject({ source: 'cv_master', status: 'validated', sourceRef: `cv:${draftId}` });
  });

  it('ne remplace le master qu’après validation explicite d’une nouvelle version', async () => {
    const fork = await api.post(`/api/profile/cv/${draftId}/fork`);
    const v2 = fork.data.cv;
    expect(v2).toMatchObject({ status: 'draft', version: 2, parentId: draftId, isCurrent: false });
    v2.data.experiences[0].bullets.push({ id: '', text: 'Participation à deux missions de due diligence financière côté acquéreur.' });
    await api.put(`/api/profile/cv/${v2.id}`, { data: v2.data });
    // Tant que le brouillon n'est pas validé, le master courant reste la version 1.
    expect((await getCurrentMaster(t.ctx.db, userId))!.id).toBe(draftId);

    const diff = await api.get(`/api/profile/cv/${v2.id}/diff`);
    expect(diff.data.changes).toEqual([{ kind: 'added', section: 'Expériences', where: 'Auditrice senior (Senior 2) — Hartwell & Associés', after: 'Participation à deux missions de due diligence financière côté acquéreur.' }]);

    await api.post(`/api/profile/cv/${v2.id}/approve`);
    expect((await getCurrentMaster(t.ctx.db, userId))!.id).toBe(v2.id);
    // L'ancienne version est conservée dans l'historique.
    const versions = (await api.get('/api/profile/cv?kind=master')).data.versions;
    expect(versions.map((v: any) => [v.version, v.status, v.isCurrent])).toEqual([
      [2, 'approved', true],
      [1, 'approved', false],
    ]);
  });

  it('gère un master par langue', async () => {
    const en = `Camille DURAND\nSenior Financial Auditor\ncamille.durand@example.test | +33 6 00 00 00 00 | Paris, France\n\nEXPERIENCE\n\nHartwell & Associés — Senior Auditor\nParis, France | September 2021 – Present\n- Audit of the consolidated accounts of French subsidiaries of US listed groups under US GAAP and PCAOB standards.\n- Supervision of teams of two to four junior auditors and review of their work with the managers.\n\nEDUCATION\n\nInstitut Supérieur de Gestion de Lyon — Master in Management\nLyon, France | 2017 – 2021\n\nLANGUAGES\nFrench: native\nEnglish: fluent\n`;
    const res = await api.post('/api/profile/cv/import-text', { text: en });
    expect(res.data.cv).toMatchObject({ language: 'en', version: 1, status: 'draft' });
    await api.post(`/api/profile/cv/${res.data.cv.id}/approve`);
    expect((await getCurrentMaster(t.ctx.db, userId, 'en'))!.language).toBe('en');
    expect((await getCurrentMaster(t.ctx.db, userId, 'fr'))!.language).toBe('fr');
    expect((await api.get('/api/profile/summary')).data.masters).toHaveLength(2);
  });

  it('sert les documents à leur seul propriétaire', async () => {
    const master = await getCurrentMaster(t.ctx.db, userId, 'fr');
    const res = await api.get(`/api/files/${master!.sourceFileId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect((await client(t.app).get(`/api/files/${master!.sourceFileId}`)).status).toBe(401);
  });
});

describe('référentiel personnel', () => {
  it('enregistre une information validée et conserve l’historique', async () => {
    await api.put('/api/profile/facts', { key: 'availability.notice_period', value: '3 mois' });
    await api.put('/api/profile/facts', { key: 'availability.notice_period', value: '3 mois, négociable' });
    expect(await getFactValue(t.ctx.db, userId, 'availability.notice_period')).toBe('3 mois, négociable');
    const hist = await api.get('/api/profile/facts/history?key=availability.notice_period');
    expect(hist.data.history.map((h: any) => [h.value, h.status])).toEqual([
      ['3 mois, négociable', 'validated'],
      ['3 mois', 'superseded'],
    ]);
  });

  it('ne laisse jamais une source automatique écraser une information validée par l’utilisateur', async () => {
    await api.put('/api/profile/facts', { key: 'contact.phone', value: '+33 7 11 11 11 11' });
    const res = await setFact(t.ctx.db, userId, { key: 'contact.phone', value: '+33 6 00 00 00 00', source: 'linkedin' });
    expect(res.status).toBe('conflict');
    expect(await getFactValue(t.ctx.db, userId, 'contact.phone')).toBe('+33 7 11 11 11 11');
    const inbox = await api.get('/api/inbox');
    const conflict = inbox.data.items.find((i: any) => i.type === 'fact.conflict');
    expect(conflict.body).toMatchObject({ key: 'contact.phone', current: '+33 7 11 11 11 11', proposed: '+33 6 00 00 00 00', proposedSource: 'linkedin' });

    // Refusé : la valeur de l'utilisateur reste, et la même contradiction n'est plus jamais remontée.
    await api.post(`/api/profile/facts/${conflict.body.factId}/resolve`, { accept: false });
    expect(await getFactValue(t.ctx.db, userId, 'contact.phone')).toBe('+33 7 11 11 11 11');
    await setFact(t.ctx.db, userId, { key: 'contact.phone', value: '+33 6 00 00 00 00', source: 'linkedin' });
    expect((await api.get('/api/inbox')).data.items.filter((i: any) => i.type === 'fact.conflict')).toHaveLength(0);
  });

  it('masque les valeurs sensibles dans le journal', async () => {
    await api.put('/api/profile/facts', { key: 'compensation.expectations', value: [{ country: 'FR', currency: 'EUR', min: 60000, max: 70000, period: 'year' }] });
    const log = await api.get('/api/settings/activity?entityType=fact&entityId=compensation.expectations');
    expect(JSON.stringify(log.data.items)).not.toContain('60000');
  });

  it('mémorise les compétences confirmées et infirmées', async () => {
    await api.post('/api/profile/skills', { name: 'Power BI', has: false });
    await api.post('/api/profile/skills', { name: 'Modélisation financière', has: true, context: 'Modèles de suivi budgétaire sous Excel' });
    expect(await getFactValue(t.ctx.db, userId, 'skill:power bi')).toMatchObject({ has: false });
    expect(await getFactValue(t.ctx.db, userId, 'skill:modelisation financiere')).toMatchObject({ has: true });
  });
});

describe('réponses standards', () => {
  it('retrouve une réponse malgré une formulation différente, sans jamais répondre au hasard', async () => {
    await api.post('/api/profile/answers', { question: 'Quel est votre préavis ?', answer: '3 mois, négociable' });
    await api.post('/api/profile/answers', { question: 'Why do you want to work in Transaction Services?', answer: 'Réponse générale' });
    await upsertAnswer(t.ctx.db, userId, { question: 'Why do you want to work in Transaction Services?', answer: 'Réponse pour Alvarez', scope: 'company', scopeValue: 'Alvarez & Marsal' });

    const exact = await findAnswer(t.ctx.db, userId, 'Quel est votre préavis ? *');
    expect(exact).toMatchObject({ confidence: 1 });
    expect(exact!.answer.answer).toBe('3 mois, négociable');
    // La portée la plus précise l'emporte.
    expect((await findAnswer(t.ctx.db, userId, 'Why do you want to work in Transaction Services?', { company: 'Alvarez & Marsal' }))!.answer.answer).toBe('Réponse pour Alvarez');
    expect((await findAnswer(t.ctx.db, userId, 'Why do you want to work in Transaction Services?', { company: 'Kroll' }))!.answer.answer).toBe('Réponse générale');
    // Question différente : aucune réponse, elle sera posée à l'utilisateur.
    expect(await findAnswer(t.ctx.db, userId, 'Quelles sont vos prétentions salariales ?')).toBeNull();

    await recordAnswerUse(t.ctx.db, exact!.answer, 'Durée de votre préavis ?');
    const list = (await api.get('/api/profile/answers')).data.answers;
    expect(list.find((a: any) => a.id === exact!.answer.id)).toMatchObject({ usageCount: 1, variants: ['Durée de votre préavis ?'] });
    expect((await findAnswer(t.ctx.db, userId, 'Durée de votre préavis ?'))!.answer.id).toBe(exact!.answer.id);
  });
});

describe('prompt ATS', () => {
  it('enregistre le prompt tel quel, versionné, sans le réécrire', async () => {
    const mine = '  MON PROMPT ATS\n\nNote sur 20 — 40 mots-clés.\n\t— Fin (espaces et tabulations conservés)  \n';
    const saved = await api.post('/api/profile/ats-prompt', { content: mine, note: 'Ma version' });
    expect(saved.data).toMatchObject({ created: true, prompt: { version: 2, isActive: true, isDefault: false } });
    const active = (await api.get('/api/profile/ats-prompt')).data.active;
    expect(active.content).toBe(mine);

    // Contenu identique : pas de nouvelle version.
    expect((await api.post('/api/profile/ats-prompt', { content: mine })).data.created).toBe(false);
    // Un seul caractère modifié : nouvelle version traçable.
    const v3 = await api.post('/api/profile/ats-prompt', { content: `${mine} ` });
    expect(v3.data.prompt.version).toBe(3);
    expect(v3.data.prompt.sha256).not.toBe(saved.data.prompt.sha256);

    const versions = (await api.get('/api/profile/ats-prompt')).data.versions;
    expect(versions.map((v: any) => [v.version, v.isActive])).toEqual([[3, true], [2, false], [1, false]]);

    // Retour à une version précédente, sans perte d'historique.
    await api.post(`/api/profile/ats-prompt/${saved.data.prompt.id}/activate`);
    expect((await api.get('/api/profile/ats-prompt')).data.active.version).toBe(2);
    expect((await api.get('/api/inbox')).data.items.some((i: any) => i.type === 'setup.ats_prompt')).toBe(false);
    expect((await api.post('/api/profile/ats-prompt', { content: '   ' })).status).toBe(400);
  });
});

describe('isolation entre utilisateurs', () => {
  it('cloisonne strictement CV, référentiel, réponses et prompt', async () => {
    const created = await api.post('/api/admin/users', { email: 'autre@example.test', name: 'Autre', password: TEST_PASSWORD });
    expect(created.status).toBe(200);
    const other = client(t.app);
    await other.post('/api/auth/login', { email: 'autre@example.test', password: TEST_PASSWORD });

    expect((await other.get('/api/profile/cv')).data.versions).toEqual([]);
    expect((await other.get('/api/profile/facts')).data.facts).toEqual([]);
    expect((await other.get('/api/profile/answers')).data.answers).toEqual([]);
    expect((await other.get('/api/profile/ats-prompt')).data.active.isDefault).toBe(true);

    const master = await getCurrentMaster(t.ctx.db, userId, 'fr');
    expect((await other.get(`/api/profile/cv/${master!.id}`)).status).toBe(404);
    expect((await other.get(`/api/files/${master!.sourceFileId}`)).status).toBe(404);
    expect((await other.post(`/api/profile/cv/${master!.id}/fork`)).status).toBe(404);
    // Un simple utilisateur n'administre pas les comptes.
    expect((await other.get('/api/admin/users')).status).toBe(403);

    // Le propriétaire peut désactiver un compte : ses sessions tombent immédiatement.
    await api.post(`/api/admin/users/${created.data.user.id}/disable`);
    expect((await other.get('/api/me')).status).toBe(401);
  });
});
