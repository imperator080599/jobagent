import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CalendarClock, History, KeyRound, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useLocation, useParams } from 'wouter';
import type { SettingKey, SettingValue } from '../../../src/shared/settings';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, Modal, PageHeader, Select, Switch, Tabs, useToast } from '../components/ui';
import { AutopilotSettings } from './settings/Autopilot';
import { del, get, post } from '../lib/api';
import { formatDate, relativeTime } from '../lib/format';
import { errorText, useAuthStatus, useDraft, useSecret, useSetting, useSettings } from '../lib/hooks';
import { NotificationsSettings } from './settings/Notifications';
import { DataSettings } from './settings/Data';
import { MailSettings } from './settings/Mail';

const TABS = [
  { id: 'candidature', label: 'Candidature' },
  { id: 'ia', label: 'IA et budget' },
  { id: 'planification', label: 'Planification' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'messagerie', label: 'Messagerie' },
  { id: 'securite', label: 'Sécurité' },
  { id: 'donnees', label: 'Données' },
  { id: 'journal', label: 'Journal' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function SettingsPage() {
  const params = useParams<{ tab?: string }>();
  const [, navigate] = useLocation();
  const tab = (TABS.some((t) => t.id === params.tab) ? params.tab : 'candidature') as TabId;
  const settings = useSettings();
  return (
    <>
      <PageHeader title="Paramètres" description="Tout ce qui pilote le comportement de l'agent se règle ici, sans toucher au code." />
      <Tabs tabs={[...TABS]} value={tab} onChange={(id) => navigate(`/parametres/${id}`)} className="mb-5" />
      {settings.isLoading ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          {tab === 'candidature' && <ApplicationSettings />}
          {tab === 'ia' && <AiSettings />}
          {tab === 'planification' && <ScheduleSettings />}
          {tab === 'notifications' && <NotificationsSettings />}
          {tab === 'messagerie' && <MailSettings />}
          {tab === 'securite' && <SecuritySettings />}
          {tab === 'donnees' && <DataSettings />}
          {tab === 'journal' && <ActivityJournal />}
        </div>
      )}
    </>
  );
}

/** Carte de réglage générique : brouillon local, bouton « Enregistrer » actif seulement si modifié. */
export function SettingCard<K extends SettingKey>({
  settingKey,
  title,
  description,
  icon,
  children,
}: {
  settingKey: K;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  children: (value: SettingValue<K>, set: (v: SettingValue<K>) => void) => ReactNode;
}) {
  const s = useSetting(settingKey);
  const [draft, setDraft, dirty] = useDraft(s.value);
  if (draft === undefined) return null;
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        icon={icon}
        action={
          <Button variant="primary" size="sm" disabled={!dirty} loading={s.saving} onClick={() => s.save(draft)}>
            Enregistrer
          </Button>
        }
      />
      <div className="px-5 pb-5">{children(draft, setDraft)}</div>
    </Card>
  );
}

export function NumberField({ label, hint, value, onChange, min, max, step, suffix }: { label: string; hint?: ReactNode; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <Input type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step ?? 1} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} className={suffix ? 'pr-12' : ''} />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-400">{suffix}</span>}
      </div>
    </Field>
  );
}

function ApplicationSettings() {
  const mode = useSetting('application.mode');
  return (
    <>
      <Card>
        <CardHeader icon={<SlidersHorizontal className="size-4" />} title="Mode de candidature" description="Vous gardez la main sur les décisions importantes ; le reste est automatisé." />
        <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2">
          {(
            [
              { id: 'validation', title: 'Validation', text: "Chaque offre analysée vous est présentée. Vous décidez, puis l'agent prépare le CV et la lettre, que vous validez avant de postuler." },
              { id: 'autonomous', title: 'Autonome', text: "Pour les offres qui remplissent vos conditions, l'agent prépare le CV et la lettre sans attendre votre avis sur l'offre. L'envoi suit vos règles AUTOPILOT ci-dessous." },
            ] as const
          ).map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => mode.value !== o.id && mode.save(o.id)}
              className={`rounded-xl p-4 text-left ring-1 transition ring-inset ${mode.value === o.id ? 'bg-indigo-50 ring-2 ring-indigo-500' : 'bg-white ring-slate-200 hover:bg-slate-50'}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-900">{o.title}</span>
                {mode.value === o.id && <Badge tone="brand">Actif</Badge>}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{o.text}</p>
            </button>
          ))}
        </div>
      </Card>

      <AutopilotSettings />

      {mode.value === 'autonomous' && (
        <SettingCard settingKey="application.autonomous" title="Conditions du mode autonome" description="La préparation des documents ne démarre seule que si toutes ces conditions sont réunies. Une annonce suspecte ou comportant un point bloquant vous est toujours soumise.">
          {(v, set) => (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <NumberField label="Note ATS minimale" value={v.minAtsScore} min={0} max={20} step={0.5} suffix="/20" onChange={(n) => set({ ...v, minAtsScore: n })} />
                <NumberField label="Priorité minimale" value={v.minPriority} min={0} max={100} suffix="/100" onChange={(n) => set({ ...v, minPriority: n })} />
                <NumberField label="Préparations par jour (maximum)" value={v.maxPerDay} min={0} max={50} onChange={(n) => set({ ...v, maxPerDay: n })} />
              </div>
              <Switch checked={v.autoApproveDocuments} onChange={(autoApproveDocuments) => set({ ...v, autoApproveDocuments })} label="Valider automatiquement les documents qui passent tous les contrôles" description="CV et lettre sans anomalie de rendu ni affirmation à vérifier. Sinon, ils vous sont soumis." />
            </div>
          )}
        </SettingCard>
      )}

      <SettingCard settingKey="ats.thresholds" title="Seuils de décision ATS" description="Note sur 20 issue de votre prompt ATS. Une offre stratégique reste signalée même sous ces seuils.">
        {(v, set) => (
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField label="Excellente adéquation à partir de" value={v.excellent} min={0} max={20} step={0.5} suffix="/20" onChange={(n) => set({ ...v, excellent: n })} />
            <NumberField label="Candidature intéressante à partir de" value={v.interesting} min={0} max={20} step={0.5} suffix="/20" onChange={(n) => set({ ...v, interesting: n })} />
            <NumberField label="Adéquation limitée à partir de" value={v.limited} min={0} max={20} step={0.5} suffix="/20" onChange={(n) => set({ ...v, limited: n })} />
          </div>
        )}
      </SettingCard>

      <SettingCard settingKey="ats.policy" title="Quelles offres analyser ?" description="L'analyse ATS est l'étape la plus coûteuse : elle est réservée aux offres réellement pertinentes.">
        {(v, set) => (
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField label="Pertinence minimale" hint="Score d'intérêt carrière requis pour lancer l'analyse." value={v.minRelevance} min={0} max={100} suffix="/100" onChange={(n) => set({ ...v, minRelevance: n })} />
            <NumberField label="Analyses par jour (maximum)" hint="Les meilleures offres passent en premier." value={v.maxPerDay} min={0} max={200} onChange={(n) => set({ ...v, maxPerDay: n })} />
            <NumberField label="Demander mon avis à partir de" hint="En dessous, l'offre est analysée mais ne vous sollicite pas." value={v.requestFeedbackFrom} min={0} max={20} step={0.5} suffix="/20" onChange={(n) => set({ ...v, requestFeedbackFrom: n })} />
          </div>
        )}
      </SettingCard>

      <SettingCard settingKey="scoring.weights" title="Priorité de candidature" description="L'intérêt pour votre carrière et l'adéquation immédiate sont deux scores distincts ; la priorité les combine selon ces poids.">
        {(v, set) => (
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField label="Intérêt carrière" value={v.relevance} min={0} max={1} step={0.05} onChange={(n) => set({ ...v, relevance: n })} />
            <NumberField label="Adéquation du profil" value={v.fit} min={0} max={1} step={0.05} onChange={(n) => set({ ...v, fit: n })} />
            <NumberField label="Fraîcheur de l'offre" value={v.freshness} min={0} max={1} step={0.05} onChange={(n) => set({ ...v, freshness: n })} />
          </div>
        )}
      </SettingCard>
    </>
  );
}

export function SecretField({ secretKey, label, hint, placeholder }: { secretKey: string; label: string; hint?: ReactNode; placeholder?: string }) {
  const s = useSecret(secretKey);
  const [value, setValue] = useState('');
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={value}
          placeholder={s.configured ? `Configuré (${s.configured.hint}) — saisir pour remplacer` : (placeholder ?? 'Non configuré')}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          variant="primary"
          disabled={!value.trim()}
          loading={s.save.isPending}
          onClick={() => s.save.mutate(value.trim(), { onSuccess: () => setValue('') })}
        >
          Enregistrer
        </Button>
        {s.configured && (
          <Button variant="danger" icon={<Trash2 className="size-4" />} loading={s.remove.isPending} onClick={() => s.remove.mutate()} aria-label="Supprimer le secret" />
        )}
      </div>
    </Field>
  );
}

function AiSettings() {
  const settings = useSettings();
  const usage = useQuery({ queryKey: ['overview', 'llm-usage'], queryFn: () => get<{ monthUsd: number; todayUsd: number; calls: number; byPurpose: { purpose: string; usd: number; calls: number }[] }>('/overview/llm-usage') });
  const env = settings.data?.env;
  return (
    <>
      {env?.llmProvider === 'mock' && (
        <Alert tone="warning" title="Mode démonstration">
          L'IA est simulée (LLM_PROVIDER=mock) : les analyses et documents générés sont factices. Retirez cette variable pour utiliser Claude.
        </Alert>
      )}
      <Card>
        <CardHeader icon={<KeyRound className="size-4" />} title="Clé d'API Anthropic" description="Nécessaire pour l'analyse ATS, la personnalisation du CV et les lettres. Chiffrée avant enregistrement, jamais réaffichée." />
        <div className="px-5 pb-5">
          {env?.anthropicKeyFromEnv ? (
            <Alert tone="success">Une clé est fournie par l'environnement du serveur (ANTHROPIC_API_KEY). Une clé saisie ici la remplacerait pour votre compte.</Alert>
          ) : null}
          <div className="mt-3">
            <SecretField secretKey="anthropic_api_key" label="Clé d'API" hint="Créez-la sur console.anthropic.com → API Keys. Facturation à l'usage, plafonnée par le budget ci-dessous." placeholder="sk-ant-…" />
          </div>
        </div>
      </Card>

      <SettingCard settingKey="llm.models" icon={<Bot className="size-4" />} title="Modèles" description="Un modèle principal pour les tâches à forte valeur (analyse ATS, CV, lettre) et un modèle économique pour le tri en volume.">
        {(v, set) => (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Modèle principal" hint="Analyse ATS, CV, lettre de motivation.">
              <Select value={v.main} onChange={(e) => set({ ...v, main: e.target.value })}>
                <option value="claude-opus-5-5">Claude Opus 5.5 — recommandé</option>
                <option value="claude-sonnet-5-5">Claude Sonnet 5.5 — deux fois moins cher</option>
                <option value="claude-fable-5-2">Claude Fable 5.2 — le plus capable, le plus cher</option>
                <option value="claude-haiku-5-5">Claude Haiku 5.5 — très économique</option>
              </Select>
            </Field>
            <Field label="Modèle de tri" hint="Qualification des offres, extraction, classement des emails.">
              <Select value={v.bulk} onChange={(e) => set({ ...v, bulk: e.target.value })}>
                <option value="claude-haiku-5-5">Claude Haiku 5.5 — recommandé</option>
                <option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
                <option value="claude-opus-5-5">Claude Opus 5.5</option>
              </Select>
            </Field>
          </div>
        )}
      </SettingCard>

      <SettingCard settingKey="llm.budget" title="Budget IA" description="Garde-fou : une fois le plafond atteint, l'agent met les tâches IA en attente et vous prévient.">
        {(v, set) => (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField label="Plafond mensuel" value={v.monthlyUsd} min={0} step={5} suffix="USD" onChange={(n) => set({ ...v, monthlyUsd: n })} />
              <NumberField label="Plafond quotidien" value={v.dailyUsd} min={0} step={1} suffix="USD" onChange={(n) => set({ ...v, dailyUsd: n })} />
            </div>
            {usage.data && (
              <div className="rounded-xl bg-slate-50 p-4">
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                  <span>
                    Ce mois-ci : <strong>{usage.data.monthUsd.toFixed(2)} $</strong>
                  </span>
                  <span>
                    Aujourd'hui : <strong>{usage.data.todayUsd.toFixed(2)} $</strong>
                  </span>
                  <span className="text-slate-500">{usage.data.calls} appels</span>
                </div>
                {usage.data.byPurpose.length > 0 && (
                  <ul className="mt-2 grid gap-x-6 gap-y-0.5 text-[13px] text-slate-600 sm:grid-cols-2">
                    {usage.data.byPurpose.map((p) => (
                      <li key={p.purpose} className="flex justify-between">
                        <span>{p.purpose}</span>
                        <span className="tabular-nums">
                          {p.usd.toFixed(3)} $ · {p.calls}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </SettingCard>
    </>
  );
}

function ScheduleSettings() {
  const settings = useSettings();
  return (
    <>
      {settings.data?.env.serverless && (
        <Alert tone="info" title="Hébergement serverless">
          Les tâches planifiées sont déclenchées par un cron externe qui appelle l'application. La fréquence réelle ne peut pas être plus fine que celle de ce cron.
        </Alert>
      )}
      <SettingCard settingKey="schedule.search" icon={<CalendarClock className="size-4" />} title="Recherche d'offres" description="Toutes les sources actives sont interrogées à cette fréquence, sans intervention de votre part.">
        {(v, set) => (
          <div className="space-y-4">
            <Switch checked={v.enabled} onChange={(b) => set({ ...v, enabled: b })} label="Recherche automatique" />
            <div className="max-w-xs">
              <NumberField label="Toutes les" value={v.intervalHours} min={1} max={168} suffix="heures" onChange={(n) => set({ ...v, intervalHours: n })} />
            </div>
          </div>
        )}
      </SettingCard>
      <SettingCard settingKey="schedule.digest" title="Résumé quotidien" description="Un message très court : nouvelles offres, analyses, candidatures envoyées, actions en attente.">
        {(v, set) => (
          <div className="space-y-4">
            <Switch checked={v.enabled} onChange={(b) => set({ ...v, enabled: b })} label="Envoyer le résumé quotidien" description="Canal à configurer dans l'onglet Notifications." />
            <div className="grid max-w-xs grid-cols-2 gap-3">
              <NumberField label="Heure" value={v.hour} min={0} max={23} suffix="h" onChange={(n) => set({ ...v, hour: n })} />
              <NumberField label="Minute" value={v.minute} min={0} max={59} suffix="min" onChange={(n) => set({ ...v, minute: n })} />
            </div>
          </div>
        )}
      </SettingCard>
      <SettingCard settingKey="followup.rules" title="Relances" description="Délais après lesquels une candidature sans réponse appelle une relance, puis est classée « sans réponse ».">
        {(v, set) => (
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField label="Première relance après" value={v.firstAfterDays} min={1} suffix="jours" onChange={(n) => set({ ...v, firstAfterDays: n })} />
            <NumberField label="Seconde relance après" value={v.secondAfterDays} min={1} suffix="jours" onChange={(n) => set({ ...v, secondAfterDays: n })} />
            <NumberField label="Sans réponse après" value={v.noResponseAfterDays} min={1} suffix="jours" onChange={(n) => set({ ...v, noResponseAfterDays: n })} />
          </div>
        )}
      </SettingCard>
    </>
  );
}

function SecuritySettings() {
  const status = useAuthStatus();
  const qc = useQueryClient();
  const toast = useToast();
  const user = status.data?.user;
  const [pw, setPw] = useState({ current: '', next: '' });
  const changePw = useMutation({
    mutationFn: () => post('/auth/password', pw),
    onSuccess: () => {
      setPw({ current: '', next: '' });
      toast('Mot de passe modifié. Les autres sessions ont été fermées.', 'success');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });

  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState('');
  const beginTotp = useMutation({ mutationFn: () => post<{ secret: string; otpauthUrl: string }>('/auth/totp/setup'), onSuccess: setTotp, onError: (e) => toast(errorText(e), 'danger') });
  const enableTotp = useMutation({
    mutationFn: () => post<{ recoveryCodes: string[] }>('/auth/totp/enable', { code }),
    onSuccess: (r) => {
      setRecovery(r.recoveryCodes);
      setTotp(null);
      setCode('');
      void qc.invalidateQueries({ queryKey: ['auth-status'] });
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const disableTotp = useMutation({
    mutationFn: () => post('/auth/totp/disable', { password: disablePw }),
    onSuccess: () => {
      setDisablePw('');
      void qc.invalidateQueries({ queryKey: ['auth-status'] });
      toast('Double authentification désactivée');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });

  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ sessions: any[]; current: string }>('/auth/sessions') });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/auth/sessions/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });
  const revokeOthers = useMutation({ mutationFn: () => post('/auth/sessions/revoke-others'), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });

  return (
    <>
      <Card>
        <CardHeader icon={<ShieldCheck className="size-4" />} title="Double authentification" description="Fortement recommandée : cette application contient votre CV, vos coordonnées et l'accès à votre suivi de candidatures." />
        <div className="space-y-4 px-5 pb-5">
          {user?.totpEnabled ? (
            <div className="space-y-3">
              <Badge tone="success">Activée</Badge>
              <div className="flex max-w-md gap-2">
                <Input type="password" placeholder="Mot de passe pour désactiver" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
                <Button variant="danger" disabled={!disablePw} loading={disableTotp.isPending} onClick={() => disableTotp.mutate()}>
                  Désactiver
                </Button>
              </div>
            </div>
          ) : totp ? (
            <div className="space-y-3">
              <p className="text-[13px] text-slate-600">
                Ajoutez ce compte dans votre application d'authentification (clé à saisir manuellement, type « basé sur le temps »), puis entrez le code affiché.
              </p>
              <code className="block rounded-lg bg-slate-100 px-3 py-2 text-sm tracking-wider break-all">{totp.secret}</code>
              <a href={totp.otpauthUrl} className="text-[13px] font-medium text-indigo-600 hover:underline">
                Ouvrir dans l'application d'authentification de cet appareil
              </a>
              <div className="flex max-w-xs gap-2">
                <Input inputMode="numeric" placeholder="Code à 6 chiffres" value={code} onChange={(e) => setCode(e.target.value)} />
                <Button variant="primary" disabled={code.length < 6} loading={enableTotp.isPending} onClick={() => enableTotp.mutate()}>
                  Activer
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="primary" loading={beginTotp.isPending} onClick={() => beginTotp.mutate()}>
              Configurer la double authentification
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Mot de passe" />
        <div className="grid gap-4 px-5 pb-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Mot de passe actuel">
            <Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <Field label="Nouveau mot de passe">
            <Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </Field>
          <Button variant="primary" disabled={!pw.current || pw.next.length < 12} loading={changePw.isPending} onClick={() => changePw.mutate()}>
            Modifier
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Sessions ouvertes"
          description="Appareils actuellement connectés à votre compte."
          action={
            <Button size="sm" onClick={() => revokeOthers.mutate()} loading={revokeOthers.isPending}>
              Fermer les autres
            </Button>
          }
        />
        <ul className="divide-y divide-slate-100 px-5 pb-3">
          {sessions.data?.sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">{s.userAgent || 'Appareil inconnu'}</p>
                <p className="text-slate-500">
                  {s.ip} · actif {relativeTime(s.lastSeenAt)}
                </p>
              </div>
              {s.id === sessions.data?.current ? <Badge tone="success">Cette session</Badge> : <Button size="sm" variant="danger" onClick={() => revoke.mutate(s.id)}>Fermer</Button>}
            </li>
          ))}
        </ul>
      </Card>

      <Modal
        open={Boolean(recovery)}
        onClose={() => setRecovery(null)}
        title="Codes de secours"
        footer={
          <Button variant="primary" onClick={() => setRecovery(null)}>
            Je les ai conservés
          </Button>
        }
      >
        <p className="mb-3 text-sm text-slate-600">Conservez ces codes en lieu sûr. Chacun permet une connexion si vous perdez votre téléphone. Ils ne seront plus affichés.</p>
        <div className="grid grid-cols-2 gap-2 font-mono text-sm">{recovery?.map((c) => <code key={c} className="rounded bg-slate-100 px-2 py-1">{c}</code>)}</div>
      </Modal>
    </>
  );
}

function ActivityJournal() {
  const q = useQuery({ queryKey: ['activity'], queryFn: () => get<{ items: any[] }>('/settings/activity?limit=200') });
  if (q.isLoading) return <Loading />;
  return (
    <Card>
      <CardHeader icon={<History className="size-4" />} title="Journal d'activité" description="Tout ce que l'agent et vous avez fait, dans l'ordre. Rien n'est supprimé." />
      <ul className="divide-y divide-slate-100 px-5 pb-3">
        {q.data?.items.map((a) => (
          <li key={a.id} className="flex items-start justify-between gap-4 py-2.5 text-[13px]">
            <div className="min-w-0">
              <p className="text-slate-800">
                {a.level === 'error' && <Badge tone="danger" className="mr-1.5">Erreur</Badge>}
                {a.level === 'warn' && <Badge tone="warning" className="mr-1.5">Attention</Badge>}
                {a.summary || a.action}
              </p>
              <p className="text-xs text-slate-400">
                {a.actor} · {a.action}
              </p>
            </div>
            <time className="shrink-0 text-xs text-slate-400" title={formatDate(a.at, true)}>
              {relativeTime(a.at)}
            </time>
          </li>
        ))}
        {q.data?.items.length === 0 && <li className="py-6 text-center text-sm text-slate-500">Aucune activité pour le moment.</li>}
      </ul>
    </Card>
  );
}
