// Recherche : ce que l'agent cherche (critères), où il cherche (sources), les
// entreprises que vous visez, et ce qu'il a réellement pu lire (couverture, historique).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CircleAlert, CircleCheck, CirclePause, Pencil, Play, Plus, Radar, Rss, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { CONTRACTS, CONTRACT_LABELS, SENIORITIES, SENIORITY_LABELS, type SearchCriteria } from '../../../src/shared/search';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, IconButton, Input, Loading, Modal, PageHeader, Select, Switch, Tabs, TagInput, type Tone, useToast } from '../components/ui';
import { CoverageTab } from './search/Coverage';
import { del, get, patch, post, put } from '../lib/api';
import { cx, formatDate, relativeTime } from '../lib/format';
import { errorText } from '../lib/hooks';
import { SecretField } from './Settings';

const TABS = [
  { id: 'criteres', label: 'Critères' },
  { id: 'sources', label: 'Sources' },
  { id: 'entreprises', label: 'Entreprises' },
  { id: 'couverture', label: 'Couverture' },
  { id: 'historique', label: 'Historique' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const EMPTY: SearchCriteria = { titles: [], keywords: [], excludeKeywords: [], countries: [], cities: [], remoteAnywhere: false, contracts: [], seniority: [], maxYearsRequired: null, languages: [], maxAgeDays: 60 };
const COUNTRIES = ['FR', 'LU', 'CH', 'BE', 'GB', 'DE', 'NL', 'ES', 'IT', 'IE', 'US', 'CA', 'SG', 'AE', 'HK', 'AU'];

interface Profile {
  id: string;
  name: string;
  enabled: boolean;
  criteria: SearchCriteria;
  variants: number;
}

function Chips<T extends string>({ options, labels, value, onChange }: { options: readonly T[]; labels: Record<T, string>; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button key={o} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])} className={cx('rounded-lg px-2.5 py-1 text-[13px] font-medium ring-1 ring-inset transition-colors', on ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50')}>
            {labels[o]}
          </button>
        );
      })}
    </div>
  );
}

function ProfileModal({ profile, onClose }: { profile: Profile | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [c, setC] = useState<SearchCriteria>(EMPTY);
  useEffect(() => {
    if (profile === 'new') {
      setName('');
      setEnabled(true);
      setC(EMPTY);
    } else if (profile) {
      setName(profile.name);
      setEnabled(profile.enabled);
      setC(profile.criteria);
    }
  }, [profile]);
  const variants = useQuery({ queryKey: ['search', 'expand', c.titles], queryFn: () => post<{ variants: string[] }>('/search/expand', { titles: c.titles }), enabled: Boolean(profile) && c.titles.length > 0 });
  const save = useMutation({
    mutationFn: () => (profile && profile !== 'new' ? put(`/search/profiles/${profile.id}`, { name, enabled, criteria: c }) : post('/search/profiles', { name, enabled, criteria: c })),
    onSuccess: () => {
      toast('Recherche enregistrée.', 'success');
      void qc.invalidateQueries({ queryKey: ['search'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      onClose();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const set = (p: Partial<SearchCriteria>) => setC({ ...c, ...p });
  const extra = (variants.data?.variants ?? []).filter((v) => !c.titles.some((t) => t.toLowerCase() === v.toLowerCase()));
  return (
    <Modal
      open={Boolean(profile)}
      onClose={onClose}
      wide
      title={profile === 'new' ? 'Nouvelle recherche' : 'Modifier la recherche'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim() || (c.titles.length === 0 && c.keywords.length === 0)} onClick={() => save.mutate()}>Enregistrer</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Nom de la recherche"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Transaction Services — France et Luxembourg" autoFocus /></Field>
          <div className="pb-1.5"><Switch checked={enabled} onChange={setEnabled} label="Active" /></div>
        </div>
        <Field label="Intitulés visés" hint="Entrée pour valider chaque intitulé. Les équivalents connus (autre langue, autre appellation) sont recherchés automatiquement.">
          <TagInput value={c.titles} onChange={(titles) => set({ titles })} placeholder="Consultant Transaction Services, Analyste M&A…" />
        </Field>
        {extra.length > 0 && (
          <p className="-mt-2 text-[12px] leading-relaxed text-slate-500">
            Également recherchés : {extra.slice(0, 14).join(' · ')}{extra.length > 14 ? ` · +${extra.length - 14}` : ''}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Mots-clés souhaités" hint="Leur présence dans un intitulé suffit à retenir l'offre.">
            <TagInput value={c.keywords} onChange={(keywords) => set({ keywords })} placeholder="due diligence, IFRS…" />
          </Field>
          <Field label="À exclure" hint="Un intitulé contenant l'un de ces mots est écarté.">
            <TagInput value={c.excludeKeywords} onChange={(excludeKeywords) => set({ excludeKeywords })} placeholder="stage, alternance, commercial…" />
          </Field>
          <Field label="Pays" hint="Codes à deux lettres. Vide = tous les pays.">
            <TagInput value={c.countries} onChange={(v) => set({ countries: v.map((x) => x.toUpperCase().slice(0, 2)) })} placeholder="FR, LU, CH…" suggestions={COUNTRIES} />
          </Field>
          <Field label="Villes" hint="Facultatif : une autre ville du pays reste acceptée, avec une réserve.">
            <TagInput value={c.cities} onChange={(cities) => set({ cities })} placeholder="Paris, Luxembourg, Genève…" />
          </Field>
        </div>
        <Field label="Types de contrat" hint="Aucun choix = tous les contrats.">
          <Chips options={CONTRACTS} labels={CONTRACT_LABELS} value={c.contracts} onChange={(contracts) => set({ contracts })} />
        </Field>
        <Field label="Niveaux" hint="Aucun choix = tous les niveaux.">
          <Chips options={SENIORITIES} labels={SENIORITY_LABELS} value={c.seniority} onChange={(seniority) => set({ seniority })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Expérience exigée, au plus" hint="En années. Vide = pas de limite.">
            <Input type="number" min={0} max={40} value={c.maxYearsRequired ?? ''} onChange={(e) => set({ maxYearsRequired: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          <Field label="Ancienneté maximale" hint="Âge d'une annonce, en jours.">
            <Input type="number" min={1} max={365} value={c.maxAgeDays} onChange={(e) => set({ maxAgeDays: Math.max(1, Number(e.target.value) || 60) })} />
          </Field>
          <div className="self-end pb-1.5"><Switch checked={c.remoteAnywhere} onChange={(remoteAnywhere) => set({ remoteAnywhere })} label="Télétravail complet accepté hors de ces pays" /></div>
        </div>
      </div>
    </Modal>
  );
}

function CriteriaTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['search', 'profiles'], queryFn: () => get<{ profiles: Profile[] }>('/search/profiles') });
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => del(`/search/profiles/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['search'] }), onError: (e) => toast(errorText(e), 'danger') });
  if (q.isLoading) return <Loading />;
  const profiles = q.data?.profiles ?? [];
  return (
    <div className="space-y-4">
      {profiles.length === 0 ? (
        <Card>
          <EmptyState icon={<Radar className="size-5 text-slate-400" />} title="Aucune recherche définie" description="Décrivez le poste que vous visez : l'agent s'en sert pour interroger les sources, sélectionner les offres et les classer. Vous pouvez en créer plusieurs (par métier ou par pays)." action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Créer ma première recherche</Button>} />
        </Card>
      ) : (
        <>
          <div className="flex justify-end"><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Nouvelle recherche</Button></div>
          {profiles.map((p) => (
            <Card key={p.id} className="p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[15px] font-semibold text-slate-900">{p.name}</h2>
                    <Badge tone={p.enabled ? 'success' : 'neutral'}>{p.enabled ? 'Active' : 'En pause'}</Badge>
                  </div>
                  <p className="mt-1 text-[13px] text-slate-600">{p.criteria.titles.join(' · ') || 'Aucun intitulé'}</p>
                  <p className="mt-1 text-[12.5px] text-slate-500">
                    {[
                      p.variants > p.criteria.titles.length ? `${p.variants - p.criteria.titles.length} équivalent(s) recherché(s) aussi` : '',
                      p.criteria.countries.length ? `Pays : ${p.criteria.countries.join(', ')}` : 'Tous pays',
                      p.criteria.contracts.length ? p.criteria.contracts.map((x) => CONTRACT_LABELS[x]).join(', ') : 'Tous contrats',
                      p.criteria.excludeKeywords.length ? `Exclus : ${p.criteria.excludeKeywords.join(', ')}` : '',
                    ].filter(Boolean).join(' — ')}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <IconButton label="Modifier" onClick={() => setEditing(p)}><Pencil className="size-4" /></IconButton>
                  <IconButton label="Supprimer" onClick={() => window.confirm(`Supprimer la recherche « ${p.name} » ?`) && remove.mutate(p.id)}><Trash2 className="size-4" /></IconButton>
                </div>
              </div>
            </Card>
          ))}
        </>
      )}
      <ProfileModal profile={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

interface SourceRow {
  id: string;
  type: string;
  name: string;
  label: string;
  mode: string;
  access: string;
  enabled: boolean;
  health: 'unknown' | 'ok' | 'degraded' | 'failing' | 'needs_config';
  intervalMinutes: number;
  lastRunAt: string | null;
  lastCompleteAt: string | null;
  lastError: string;
  liveJobs: number;
  lastRun: { status: string; startedAt: string; itemsSeen: number; itemsRelevant: number; itemsNew: number; itemsExpired: number; requests: number; incompleteReason: string; error: string } | null;
}
interface ConnectorInfo {
  type: string;
  label: string;
  mode: string;
  description: string;
  access: string;
  fields: { key: string; label: string; hint?: string; placeholder?: string; required?: boolean }[];
  secrets: { key: string; label: string; help: string; configured: boolean }[];
}

const HEALTH: Record<SourceRow['health'], { label: string; tone: Tone }> = {
  ok: { label: 'Fonctionne', tone: 'success' },
  unknown: { label: 'Jamais lue', tone: 'neutral' },
  degraded: { label: 'Erreur passagère', tone: 'warning' },
  failing: { label: 'En panne', tone: 'danger' },
  needs_config: { label: 'À configurer', tone: 'warning' },
};

function AddSourceModal({ open, onClose, connectors }: { open: boolean; onClose: () => void; connectors: ConnectorInfo[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [type, setType] = useState('');
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const connector = connectors.find((k) => k.type === type);
  const reset = () => {
    setUrl('');
    setType('');
    setName('');
    setConfig({});
    setNote('');
  };
  const detect = useMutation({
    mutationFn: () => post<{ type: string | null; label?: string; config?: Record<string, string>; name?: string }>('/search/detect', { url }),
    onSuccess: (d) => {
      if (!d.type) {
        setNote("Plateforme non reconnue. Choisissez un type de source ci-dessous, ou ajoutez les offres de ce site à la main (ou par vos alertes email).");
        return;
      }
      setType(d.type);
      setConfig(Object.fromEntries(Object.entries(d.config ?? {}).map(([k, v]) => [k, String(v)])));
      setName(d.name ?? '');
      setNote(`Site carrières ${d.label} reconnu : vérifiez le nom de l'entreprise puis ajoutez.`);
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const add = useMutation({
    mutationFn: () => post('/search/sources', { type, name: name.trim(), config }),
    onSuccess: () => {
      toast('Source ajoutée : première lecture en cours.', 'success');
      void qc.invalidateQueries({ queryKey: ['search'] });
      reset();
      onClose();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const ready = Boolean(connector && name.trim() && connector.fields.filter((f) => f.required).every((f) => (config[f.key] ?? '').trim()));
  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      wide
      title="Ajouter une source"
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Annuler</Button>
          <Button variant="primary" loading={add.isPending} disabled={!ready} onClick={() => add.mutate()}>Ajouter</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Adresse du site carrières d'une entreprise" hint="Collez l'adresse de la page « carrières » : si elle repose sur Greenhouse, Lever, Ashby ou SmartRecruiters, tout est configuré automatiquement.">
          <div className="flex gap-2">
            <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://boards.greenhouse.io/entreprise" />
            <Button loading={detect.isPending} disabled={url.trim().length < 6} onClick={() => detect.mutate()}>Reconnaître</Button>
          </div>
        </Field>
        {note && <Alert tone="info">{note}</Alert>}
        <Field label="Type de source">
          <Select value={type} onChange={(e) => { setType(e.target.value); setConfig({}); }}>
            <option value="">Choisir…</option>
            {connectors.map((k) => <option key={k.type} value={k.type}>{k.label}</option>)}
          </Select>
        </Field>
        {connector && (
          <>
            <p className="rounded-lg bg-slate-50 p-3 text-[12.5px] leading-relaxed text-slate-600">
              {connector.description}
              <span className="mt-1 block text-slate-500">Accès : {connector.access}.</span>
            </p>
            <Field label="Nom de la source"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={connector.mode === 'board' ? "Nom de l'entreprise" : connector.label} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              {connector.fields.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  <Input value={config[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
                </Field>
              ))}
            </div>
            {connector.secrets.map((s) => <SecretField key={s.key} secretKey={s.key} label={s.label} hint={s.help || 'Chiffrée, jamais réaffichée.'} />)}
          </>
        )}
      </div>
    </Modal>
  );
}

function SourcesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['search', 'sources'], queryFn: () => get<{ sources: SourceRow[] }>('/search/sources'), refetchInterval: 10_000 });
  const connectors = useQuery({ queryKey: ['search', 'connectors'], queryFn: () => get<{ connectors: ConnectorInfo[] }>('/search/connectors') });
  const [adding, setAdding] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['search'] });
  const onError = (e: unknown) => toast(errorText(e), 'danger');
  const run = useMutation({ mutationFn: (id: string) => post(`/search/sources/${id}/run`), onSuccess: () => { toast('Lecture lancée.'); refresh(); }, onError });
  const toggle = useMutation({ mutationFn: (s: SourceRow) => patch(`/search/sources/${s.id}`, { enabled: !s.enabled }), onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: (id: string) => del(`/search/sources/${id}`), onSuccess: refresh, onError });
  if (q.isLoading) return <Loading />;
  const rows = q.data?.sources ?? [];
  const auto = rows.filter((s) => s.type !== 'manual');
  return (
    <div className="space-y-4">
      <Alert tone="info" title="Ce que couvre la recherche automatique">
        Les sites carrières hébergés par Greenhouse, Lever, Ashby et SmartRecruiters, France Travail, Adzuna et les flux RSS sont lus par leurs accès officiels. LinkedIn, Indeed, Welcome to the Jungle et les sites protégés ne sont pas lus automatiquement : leurs conditions d'utilisation l'interdisent. Pour eux, ajoutez les offres à la main ou transférez vos alertes email.
      </Alert>
      <div className="flex justify-end"><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Ajouter une source</Button></div>
      {auto.length === 0 ? (
        <Card><EmptyState icon={<Rss className="size-5 text-slate-400" />} title="Aucune source automatique" description="Ajoutez le site carrières d'une entreprise que vous visez, ou un moteur d'offres avec vos identifiants gratuits." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {auto.map((s) => {
              const h = HEALTH[s.health];
              const r = s.lastRun;
              return (
                <li key={s.id} className={cx('flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4', !s.enabled && 'opacity-60')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">{s.name}</span>
                      <Badge>{s.label}</Badge>
                      <Badge tone={s.enabled ? h.tone : 'neutral'}>{s.enabled ? h.label : 'En pause'}</Badge>
                      {r && r.status === 'failed' && s.health !== 'failing' && s.health !== 'needs_config' && <Badge tone="warning">Dernière lecture en échec</Badge>}
                      {r && r.status === 'partial' && <Badge tone="warning" title={r.incompleteReason}>Lecture partielle</Badge>}
                      {r && r.status === 'complete' && <Badge tone="success">Lecture complète</Badge>}
                    </div>
                    {r && r.status === 'running' ? (
                      <p className="mt-1 text-[12.5px] font-medium text-indigo-700">Lecture en cours…</p>
                    ) : r ? (
                      <p className="mt-1 text-[12.5px] text-slate-600">
                        {r.itemsSeen} offre(s) lue(s) · {r.itemsRelevant} pertinente(s) · {r.itemsNew} nouvelle(s){r.itemsExpired ? ` · ${r.itemsExpired} retirée(s)` : ''} — {relativeTime(r.startedAt)}
                        {r.status === 'partial' && r.incompleteReason && <span className="text-amber-700"> · {r.incompleteReason}</span>}
                      </p>
                    ) : (
                      <p className="mt-1 text-[12.5px] text-slate-500">Première lecture en attente.</p>
                    )}
                    {(s.health === 'failing' || s.health === 'needs_config' || s.health === 'degraded') && s.lastError && (
                      <p className="mt-1 flex gap-1.5 text-[12.5px] text-rose-700"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{s.lastError}</p>
                    )}
                    <p className="mt-0.5 text-[11.5px] text-slate-400">{s.liveJobs} offre(s) en ligne suivie(s) · lue toutes les {s.intervalMinutes >= 120 ? `${Math.round(s.intervalMinutes / 60)} h` : `${s.intervalMinutes} min`} · {s.access}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <IconButton label="Lire maintenant" onClick={() => run.mutate(s.id)}><Play className="size-4" /></IconButton>
                    <IconButton label={s.enabled ? 'Mettre en pause' : 'Réactiver'} onClick={() => toggle.mutate(s)}>{s.enabled ? <CirclePause className="size-4" /> : <CircleCheck className="size-4" />}</IconButton>
                    <IconButton label="Supprimer" onClick={() => window.confirm(`Supprimer la source « ${s.name} » ? Les offres déjà trouvées sont conservées.`) && remove.mutate(s.id)}><Trash2 className="size-4" /></IconButton>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <AddSourceModal open={adding} onClose={() => setAdding(false)} connectors={connectors.data?.connectors ?? []} />
    </div>
  );
}

const TIERS = { dream: 'Prioritaire', target: 'Ciblée', watch: 'À surveiller', excluded: 'Exclue' } as const;
const TIER_TONES: Record<keyof typeof TIERS, Tone> = { dream: 'brand', target: 'success', watch: 'neutral', excluded: 'danger' };

function CompaniesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['search', 'companies'], queryFn: () => get<{ companies: { id: string; name: string; tier: keyof typeof TIERS; careersUrl: string; ats: string; discovery: 'unknown' | 'found' | 'not_found' | 'ambiguous'; discoveryNote: string; origin: string; jobsSeen: number; tags: string[]; lastCheckedAt: string | null }[] }>('/search/companies'), refetchInterval: 30_000 });
  const discover = useMutation({ mutationFn: (id: string) => post(`/search/companies/${id}/discover`, {}), onSuccess: () => toast('Recherche du site carrières lancée.', 'success'), onError: (e) => toast(errorText(e), 'danger') });
  const seed = useMutation({
    mutationFn: () => post<{ added: number }>('/search/companies/seed', {}),
    onSuccess: (d) => {
      toast(`${d.added} employeur(s) ajouté(s) ; leurs sites carrières vont être recherchés et vérifiés.`, 'success');
      void qc.invalidateQueries({ queryKey: ['search'] });
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const [name, setName] = useState('');
  const [tier, setTier] = useState<keyof typeof TIERS>('target');
  const [url, setUrl] = useState('');
  const add = useMutation({
    mutationFn: () => post<{ detected: string | null; source: unknown }>('/search/companies', { name, tier, careersUrl: url }),
    onSuccess: (d) => {
      toast(d.source ? `Entreprise ajoutée. Son site carrières ${d.detected} est désormais surveillé.` : url && tier !== 'excluded' ? "Entreprise ajoutée. Son site carrières n'a pas été reconnu : ses offres ne seront pas lues automatiquement." : 'Entreprise ajoutée.', d.source ? 'success' : 'neutral');
      setName('');
      setUrl('');
      void qc.invalidateQueries({ queryKey: ['search'] });
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/search/companies/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['search'] }), onError: (e) => toast(errorText(e), 'danger') });
  if (q.isLoading) return <Loading />;
  const list = q.data?.companies ?? [];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Building2 className="size-4" />}
          title="Entreprises que vous visez"
          description="Les offres d'une entreprise prioritaire ou ciblée remontent dans le classement et ne sont jamais masquées par le seuil de pertinence. Leur site carrières est recherché, vérifié puis suivi automatiquement ; une entreprise découverte par une offre rejoint l'annuaire « à surveiller »."
          action={
            <Button size="sm" loading={seed.isPending} onClick={() => seed.mutate()}>
              Ajouter les employeurs de départ
            </Button>
          }
        />
        <div className="grid gap-3 px-5 pb-5 sm:grid-cols-[1.2fr_0.8fr_1.6fr_auto] sm:items-end">
          <Field label="Entreprise"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom" /></Field>
          <Field label="Statut">
            <Select value={tier} onChange={(e) => setTier(e.target.value as keyof typeof TIERS)}>
              {(Object.keys(TIERS) as (keyof typeof TIERS)[]).map((t) => <option key={t} value={t}>{TIERS[t]}</option>)}
            </Select>
          </Field>
          <Field label="Site carrières (facultatif)"><Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>
          <Button variant="primary" loading={add.isPending} disabled={!name.trim()} onClick={() => add.mutate()}>Ajouter</Button>
        </div>
      </Card>
      {list.length > 0 && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {list.map((co) => (
              <li key={co.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {co.name} {co.tags.length > 0 && <span className="text-xs font-normal text-slate-400">· {co.tags.join(', ')}</span>}
                  </p>
                  <p className="truncate text-xs text-slate-500" title={co.discoveryNote}>
                    {co.discovery === 'found' ? `Site carrières suivi (${co.ats}).` : co.discovery === 'ambiguous' ? 'Site trouvé, à confirmer.' : co.discovery === 'not_found' ? 'Site carrières introuvable automatiquement : indiquez son adresse.' : 'Recherche du site carrières à venir.'}
                    {co.jobsSeen > 0 && ` · ${co.jobsSeen} offre(s) vue(s)`}
                    {co.lastCheckedAt && ` · vérifié ${formatDate(co.lastCheckedAt)}`}
                  </p>
                </div>
                <Badge tone={TIER_TONES[co.tier]}>{TIERS[co.tier]}</Badge>
                {co.discovery !== 'found' && co.tier !== 'excluded' && (
                  <Button size="sm" variant="ghost" loading={discover.isPending && discover.variables === co.id} onClick={() => discover.mutate(co.id)}>
                    Chercher
                  </Button>
                )}
                <IconButton label="Retirer" onClick={() => remove.mutate(co.id)}><Trash2 className="size-4" /></IconButton>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function HistoryTab() {
  const q = useQuery({ queryKey: ['search', 'runs'], queryFn: () => get<{ runs: { id: string; sourceName: string | null; trigger: string; status: string; startedAt: string; itemsSeen: number; itemsRelevant: number; itemsNew: number; itemsDuplicate: number; itemsExpired: number; requests: number; incompleteReason: string; error: string }[] }>('/search/runs'), refetchInterval: 15_000 });
  if (q.isLoading) return <Loading />;
  const runs = q.data?.runs ?? [];
  if (!runs.length) return <Card><EmptyState icon={<Radar className="size-5 text-slate-400" />} title="Aucune collecte pour le moment" description="Chaque lecture d'une source est consignée ici, avec ce qu'elle a réellement couvert." /></Card>;
  const STATUS: Record<string, { label: string; tone: Tone }> = { complete: { label: 'Complète', tone: 'success' }, partial: { label: 'Partielle', tone: 'warning' }, failed: { label: 'Échec', tone: 'danger' }, running: { label: 'En cours', tone: 'info' } };
  return (
    <Card className="overflow-hidden">
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="bg-slate-50 text-[12px] text-slate-500">
            <tr>{['Date', 'Source', 'Couverture', 'Lues', 'Pertinentes', 'Nouvelles', 'Déjà connues', 'Retirées', 'Requêtes'].map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-3 py-2 whitespace-nowrap text-slate-500">{formatDate(r.startedAt, true)}</td>
                <td className="px-3 py-2 font-medium text-slate-900">{r.sourceName ?? 'Source supprimée'}</td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS[r.status]?.tone ?? 'neutral'}>{STATUS[r.status]?.label ?? r.status}</Badge>
                  {(r.incompleteReason || r.error) && <p className="mt-1 max-w-64 text-[12px] text-slate-500">{r.error || r.incompleteReason}</p>}
                </td>
                {[r.itemsSeen, r.itemsRelevant, r.itemsNew, r.itemsDuplicate, r.itemsExpired, r.requests].map((n, i) => <td key={i} className="px-3 py-2 text-slate-700 tabular-nums">{n}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function SearchPage() {
  const params = useParams<{ tab?: string }>();
  const [, navigate] = useLocation();
  const tab = (TABS.some((t) => t.id === params.tab) ? params.tab : 'criteres') as TabId;
  return (
    <>
      <PageHeader title="Recherche" description="Ce que l'agent cherche, où il le cherche, et ce qu'il a réellement pu lire. Aucune source n'est présentée comme couverte en entier si elle ne l'a pas été." />
      <Tabs tabs={[...TABS]} value={tab} onChange={(id) => navigate(`/recherche/${id}`)} className="mb-5" />
      {tab === 'criteres' && <CriteriaTab />}
      {tab === 'sources' && <SourcesTab />}
      {tab === 'entreprises' && <CompaniesTab />}
      {tab === 'couverture' && <CoverageTab />}
      {tab === 'historique' && <HistoryTab />}
    </>
  );
}
