// Matrice de couverture des sources : pour chaque plateforme, comment les offres sont
// obtenues, ce qui a réellement été lu, quand, avec quelles erreurs et quelles limites.
// Règle : une source n'est « opérationnelle » qu'après une lecture réussie enregistrée.
// Aucune exhaustivité absolue n'est revendiquée.
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { getSetting } from '../core/settings.js';
import { companies, jobSightings, sources } from '../db/schema.js';
import { PLATFORM_POLICIES, type PlatformId } from '../apply/platforms.js';
import { CONNECTORS } from './connectors/index.js';

export type CoverageStatus = 'operational' | 'configured_untested' | 'error' | 'not_configured' | 'unavailable' | 'alerts_waiting';

export interface CoverageRow {
  id: string;
  name: string;
  category: 'ats' | 'aggregator' | 'job_board' | 'finance' | 'public' | 'directory';
  method: string;
  status: CoverageStatus;
  statusLabel: string;
  sources: number;
  liveJobs: number;
  lastSuccessAt: string | null;
  lastError: string;
  incomplete: string;
  limits: string[];
  evidence: { url: string; quote: string; checkedAt: string }[];
}

const STATUS_LABEL: Record<CoverageStatus, string> = {
  operational: 'Opérationnelle (lecture réussie)',
  configured_untested: 'Configurée — jamais lue avec succès',
  error: 'En erreur',
  not_configured: 'Disponible — à configurer',
  unavailable: 'Indisponible',
  alerts_waiting: 'En attente d’alertes',
};

/** Hôtes des plateformes lues par alertes e-mail (pour compter les offres réellement reçues). */
const ALERT_HOSTS: Partial<Record<PlatformId | 'monster' | 'cadremploi', RegExp>> = {
  linkedin: /linkedin\.com/,
  indeed: /indeed\./,
  wttj: /welcometothejungle\.com/,
  apec: /apec\.fr/,
  hellowork: /hellowork\.com/,
  glassdoor: /glassdoor\./,
  jobteaser: /jobteaser\.com/,
  efinancialcareers: /efinancialcareers\./,
  vie: /mon-vie-via\.businessfrance\.fr|civiweb\.com/,
  francetravail: /francetravail\.fr|pole-emploi\.fr/,
  monster: /monster\./,
  cadremploi: /cadremploi\.fr/,
};

export async function coverageMatrix(ctx: UserContext): Promise<{ rows: CoverageRow[]; companies: Record<string, number>; note: string }> {
  const list = await ctx.db.select().from(sources).where(eq(sources.userId, ctx.userId));
  const live = await ctx.db
    .select({ sourceId: jobSightings.sourceId, n: sql<number>`count(*)::int` })
    .from(jobSightings)
    .where(and(eq(jobSightings.userId, ctx.userId), isNull(jobSightings.goneAt)))
    .groupBy(jobSightings.sourceId);
  const liveBy = new Map(live.map((l) => [l.sourceId, l.n]));
  const rows: CoverageRow[] = [];

  // 1. Connecteurs (API publiques de lecture, flux) : statut tiré des exécutions réelles.
  for (const c of CONNECTORS) {
    const mine = list.filter((s) => s.type === c.type);
    const ok = mine.filter((s) => s.lastSuccessAt);
    const lastSuccess = ok.map((s) => s.lastSuccessAt!).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const failing = mine.filter((s) => s.health === 'failing' || s.lastError);
    let status: CoverageStatus = mine.length ? (ok.length ? 'operational' : failing.length ? 'error' : 'configured_untested') : 'not_configured';
    const policy = PLATFORM_POLICIES[c.type as PlatformId];
    const limits: string[] = [];
    if (c.type === 'francetravail') {
      status = mine.length && ok.length ? status : 'unavailable';
      limits.push("API « Offres d'emploi » retirée temporairement par France Travail : les offres arrivent par vos alertes e-mail.");
    }
    if (/non vérifi/.test(c.access) && !ok.length) limits.push('Point d’accès non vérifié en conditions réelles : il le sera à la première lecture réussie.');
    if (c.mode === 'board') limits.push('Lit les offres des entreprises suivies (une source par entreprise) ; les nouvelles entreprises sont ajoutées par la découverte automatique.');
    if (c.partialDescriptions) limits.push('Liste sans texte complet : il est lu offre par offre avant l’analyse ATS.');
    rows.push({
      id: c.type,
      name: c.label,
      category: c.mode === 'board' ? 'ats' : c.type === 'feed' ? 'public' : 'aggregator',
      method: c.access,
      status,
      statusLabel: STATUS_LABEL[status],
      sources: mine.length,
      liveJobs: mine.reduce((a, s) => a + (liveBy.get(s.id) ?? 0), 0),
      lastSuccessAt: lastSuccess?.toISOString() ?? null,
      lastError: failing[0]?.lastError ?? '',
      incomplete: '',
      limits,
      evidence: policy?.evidence.filter((e) => /docs|developer|github|data\.gouv/.test(e.url)).slice(0, 1) ?? (c.type === 'francetravail' ? PLATFORM_POLICIES.francetravail.evidence : []),
    });
  }

  // 2. Plateformes lues par vos alertes e-mail (aucune lecture automatisée de leurs sites).
  const gmail = await getSetting(ctx.db, ctx.userId, 'email.gmail');
  const emailSource = list.find((s) => s.type === 'email');
  const since = new Date(ctx.now().getTime() - 30 * 86400_000);
  const alertUrls = emailSource
    ? await ctx.db.select({ url: jobSightings.url, lastSeenAt: jobSightings.lastSeenAt }).from(jobSightings).where(and(eq(jobSightings.sourceId, emailSource.id), gte(jobSightings.lastSeenAt, since)))
    : [];
  const alertPlatforms: { id: PlatformId | 'monster' | 'cadremploi'; name: string; category: CoverageRow['category'] }[] = [
    { id: 'linkedin', name: 'LinkedIn Jobs', category: 'job_board' },
    { id: 'indeed', name: 'Indeed', category: 'job_board' },
    { id: 'wttj', name: 'Welcome to the Jungle', category: 'job_board' },
    { id: 'apec', name: 'Apec', category: 'job_board' },
    { id: 'hellowork', name: 'HelloWork', category: 'job_board' },
    { id: 'glassdoor', name: 'Glassdoor', category: 'job_board' },
    { id: 'monster', name: 'Monster', category: 'job_board' },
    { id: 'cadremploi', name: 'Cadremploi', category: 'job_board' },
    { id: 'jobteaser', name: 'JobTeaser', category: 'job_board' },
    { id: 'efinancialcareers', name: 'eFinancialCareers', category: 'finance' },
    { id: 'vie', name: 'Mon Volontariat International (VIE/VIA)', category: 'public' },
    { id: 'francetravail', name: 'France Travail (alertes)', category: 'public' },
  ];
  for (const p of alertPlatforms) {
    const re = ALERT_HOSTS[p.id]!;
    const hits = alertUrls.filter((u) => re.test(u.url));
    const last = hits.map((h) => h.lastSeenAt).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const status: CoverageStatus = hits.length ? 'operational' : gmail.canRead && gmail.importAlerts ? 'alerts_waiting' : 'not_configured';
    const policy = PLATFORM_POLICIES[p.id as PlatformId];
    rows.push({
      id: `alerts:${p.id}`,
      name: p.name,
      category: p.category,
      method: 'Alertes e-mail de la plateforme, lues dans votre boîte Gmail (lien de chaque offre conservé)',
      status,
      statusLabel: hits.length ? `Opérationnelle (${hits.length} offre(s) reçue(s) en 30 jours)` : status === 'alerts_waiting' ? 'Gmail connecté — aucune alerte reçue : créez une alerte sur la plateforme' : 'À configurer : créez une alerte sur la plateforme et connectez Gmail',
      sources: emailSource ? 1 : 0,
      liveJobs: hits.length,
      lastSuccessAt: last?.toISOString() ?? null,
      lastError: '',
      incomplete: 'Dépend du contenu de vos alertes : seules les offres envoyées par la plateforme sont connues.',
      limits: [...(policy?.read.verdict === 'prohibited' ? ['Lecture automatisée du site interdite par ses conditions : seules vos alertes sont utilisées.'] : []), ...(policy?.limits ?? [])],
      evidence: policy?.evidence.slice(0, 1) ?? [],
    });
  }
  rows.push({
    id: 'google_jobs',
    name: 'Google pour l’emploi',
    category: 'aggregator',
    method: '—',
    status: 'unavailable',
    statusLabel: STATUS_LABEL.unavailable,
    sources: 0,
    liveJobs: 0,
    lastSuccessAt: null,
    lastError: '',
    incomplete: '',
    limits: ["Aucune API publique de recherche d'offres pour les candidats (l'API Cloud Talent Solution de Google est destinée aux employeurs). Les offres qu'il agrège proviennent des sites carrières et ATS déjà suivis ici."],
    evidence: [],
  });

  // 3. Annuaire des employeurs : sites carrières trouvés, à confirmer, introuvables.
  const dir = await ctx.db.select({ discovery: companies.discovery, n: sql<number>`count(*)::int` }).from(companies).where(eq(companies.userId, ctx.userId)).groupBy(companies.discovery);
  const counts = Object.fromEntries(dir.map((d) => [d.discovery, d.n]));
  return { rows, companies: counts, note: "Aucune source n'est exhaustive : la couverture indique ce qui a réellement été lu, et les lectures partielles sont signalées." };
}
