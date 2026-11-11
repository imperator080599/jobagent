import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Loading, Switch, useToast } from '../../components/ui';
import { get, post, upload } from '../../lib/api';
import { formatDate, relativeTime } from '../../lib/format';
import { errorText, useSecret, useSetting } from '../../lib/hooks';
import { SecretField } from '../Settings';

interface Diff {
  id: string;
  kind: string;
  summary: string;
  cvValue: any;
  linkedinValue: any;
  proposal: any;
  status: string;
  decidedAt?: string;
}
interface State {
  snapshot: { id: string; method: string; fetchedAt: string; experiences: number; education: number; skills: number; headline: string } | null;
  diffs: Diff[];
  history: Diff[];
}

const METHODS: Record<string, string> = { export_zip: 'archive LinkedIn', profile_pdf: 'PDF du profil', dma_api: 'API officielle', paste: 'texte collé' };

function DiffCard({ diff, onDecide }: { diff: Diff; onDecide: (decision: 'accept' | 'reject' | 'ignore', selected?: string[]) => void }) {
  const isSkills = diff.kind === 'new_skills';
  const [selected, setSelected] = useState<string[]>([]);
  const informational = !diff.proposal;
  return (
    <li className="py-4">
      <p className="text-sm font-medium text-slate-900">{diff.summary}</p>
      {isSkills ? (
        <div className="mt-2">
          <p className="mb-1.5 text-xs text-slate-500">Cochez uniquement celles que vous maîtrisez réellement et souhaitez voir sur votre CV :</p>
          <div className="flex flex-wrap gap-1.5">
            {(diff.linkedinValue as string[]).map((s) => {
              const on = selected.includes(s);
              return (
                <button key={s} type="button" onClick={() => setSelected(on ? selected.filter((x) => x !== s) : [...selected, s])} className={`rounded-md px-2 py-1 text-[12.5px] ring-1 ring-inset ${on ? 'bg-emerald-50 text-emerald-800 ring-emerald-300' : 'bg-white text-slate-600 ring-slate-200'}`}>
                  {s}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        (typeof diff.cvValue === 'string' || typeof diff.linkedinValue === 'string') && (
          <div className="mt-2 grid gap-2 text-[13px] sm:grid-cols-2">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <span className="block text-[11px] font-medium text-slate-400 uppercase">CV master</span>
              {String(diff.cvValue ?? '—')}
            </div>
            <div className="rounded-lg bg-sky-50 px-3 py-2">
              <span className="block text-[11px] font-medium text-sky-600 uppercase">LinkedIn</span>
              {String(diff.linkedinValue ?? '—')}
            </div>
          </div>
        )
      )}
      {Array.isArray(diff.linkedinValue) && !isSkills && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-slate-600">
          {(diff.linkedinValue as string[]).map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!informational && (
          <Button size="sm" variant="primary" disabled={isSkills && selected.length === 0} onClick={() => onDecide('accept', isSkills ? selected : undefined)}>
            {isSkills ? 'Ajouter la sélection au CV' : 'Reporter dans mon CV master'}
          </Button>
        )}
        <Button size="sm" onClick={() => onDecide(informational ? 'ignore' : 'reject')}>
          {informational ? "J'ai compris" : 'Mon CV est correct'}
        </Button>
      </div>
    </li>
  );
}

export function LinkedinTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useQuery({ queryKey: ['linkedin'], queryFn: () => get<State>('/profile/linkedin') });
  const sync = useSetting('linkedin.sync');
  const token = useSecret('linkedin_access_token');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['linkedin'] });
    void qc.invalidateQueries({ queryKey: ['cv-versions'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
  };
  const report = (r: { changed: boolean; newDiffs: number; openDiffs: number }) => {
    refresh();
    toast(!r.changed ? 'Profil inchangé depuis la dernière synchronisation' : r.newDiffs ? `${r.newDiffs} nouvel(s) écart(s) détecté(s)` : 'Profil importé : aucun nouvel écart avec votre CV', r.newDiffs ? 'warning' : 'success');
  };
  const importFile = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('file', file);
      return upload<{ changed: boolean; newDiffs: number; openDiffs: number }>('/profile/linkedin/import', form);
    },
    onSuccess: report,
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const apiSync = useMutation({ mutationFn: () => post<{ changed: boolean; newDiffs: number; openDiffs: number }>('/profile/linkedin/sync'), onSuccess: report, onError: (e) => toast(errorText(e), 'danger') });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: string; selected?: string[] }) => post<{ draftId?: string }>(`/profile/linkedin/diffs/${v.id}`, { decision: v.decision, selected: v.selected }),
    onSuccess: (r) => {
      refresh();
      if (r.draftId) toast('Reporté dans un brouillon de CV master, à valider dans « Mes documents »', 'success');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });

  if (q.isLoading || !q.data) return <Loading />;
  const s = q.data.snapshot;
  return (
    <div className="space-y-5">
      <input ref={fileRef} type="file" accept=".zip,.pdf,application/zip,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile.mutate(f); e.target.value = ''; }} />
      <Card>
        <CardHeader
          title="Synchronisation avec LinkedIn"
          description="Uniquement par les voies officielles de LinkedIn. Vos identifiants ne sont jamais demandés et aucune navigation automatisée n'est effectuée sur votre compte."
          action={
            <Button size="sm" variant="primary" icon={<Upload className="size-4" />} loading={importFile.isPending} onClick={() => fileRef.current?.click()}>
              Importer un export
            </Button>
          }
        />
        <div className="space-y-4 px-5 pb-5 text-[13px] text-slate-600">
          {s ? (
            <p>
              Dernière synchronisation <strong>{relativeTime(s.fetchedAt)}</strong> ({METHODS[s.method] ?? s.method}) · {s.experiences} expérience(s), {s.education} formation(s), {s.skills} compétence(s).
            </p>
          ) : (
            <p>Aucun profil importé pour le moment.</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-slate-50 p-3.5">
              <p className="font-medium text-slate-800">PDF du profil — le plus rapide</p>
              <p className="mt-1 leading-relaxed">Sur votre profil LinkedIn : « Ressources » → « Enregistrer au format PDF », puis importez le fichier ici.</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-3.5">
              <p className="font-medium text-slate-800">Archive complète — la plus précise</p>
              <p className="mt-1 leading-relaxed">Préférences → Confidentialité des données → « Obtenir une copie de vos données ». Seuls les fichiers de profil sont lus ; messages et contacts sont ignorés.</p>
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={`Écarts à arbitrer (${q.data.diffs.length})`} description="Seules les différences significatives sont remontées. Rien n'est modifié sans votre décision, et un écart tranché n'est jamais reposé." />
        {q.data.diffs.length === 0 ? (
          <EmptyState title="Aucun écart en attente" description={s ? 'Votre CV master et votre profil LinkedIn sont cohérents.' : 'Importez votre profil pour lancer la comparaison.'} />
        ) : (
          <ul className="divide-y divide-slate-100 px-5">
            {q.data.diffs.map((d) => (
              <DiffCard key={d.id} diff={d} onDecide={(decision, selected) => decide.mutate({ id: d.id, decision, selected })} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          icon={<RefreshCw className="size-4" />}
          title="Vérification automatique (API officielle)"
          description="LinkedIn met à disposition des membres de l'Union européenne une API de portabilité de leurs propres données. Elle permet une vérification périodique sans aucune manipulation."
        />
        <div className="space-y-4 px-5 pb-5">
          <Alert tone="info">
            Mise en place (une seule fois) : créez une application sur le portail développeur LinkedIn, demandez le produit « Member Data Portability API (Member) », puis générez un jeton d'accès avec l'outil OAuth du portail. Le jeton expire périodiquement : l'application vous préviendra.
          </Alert>
          <SecretField secretKey="linkedin_access_token" label="Jeton d'accès LinkedIn" hint="Chiffré avant enregistrement. Il ne donne accès qu'à vos propres données, en lecture." />
          {sync.value && (
            <>
              <Switch checked={sync.value.enabled} onChange={(b) => sync.save({ ...sync.value!, enabled: b })} label={`Vérifier automatiquement tous les ${sync.value.intervalDays} jours`} description="Vous n'êtes prévenu que si une différence utile est détectée." />
              <Switch
                checked={sync.value.autoApplyFactual}
                onChange={(b) => sync.save({ ...sync.value!, autoApplyFactual: b })}
                label="Mettre à jour le CV master automatiquement pour les ajouts factuels"
                description="Nouvelle expérience, formation, certification ou langue apparue sur LinkedIn. Les contradictions (dates, intitulés) vous sont toujours soumises."
              />
            </>
          )}
          <Button icon={<RefreshCw className="size-4" />} disabled={!token.configured} loading={apiSync.isPending} onClick={() => apiSync.mutate()}>
            Synchroniser maintenant
          </Button>
        </div>
      </Card>

      {q.data.history.length > 0 && (
        <Card>
          <CardHeader title="Décisions passées" />
          <ul className="divide-y divide-slate-100 px-5 pb-3 text-[13px]">
            {q.data.history.map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-3 py-2">
                <span className="text-slate-600">{d.summary}</span>
                <span className="shrink-0 text-right">
                  <Badge tone={d.status === 'accepted' ? 'success' : 'neutral'}>{d.status === 'accepted' ? 'Reporté' : d.status === 'rejected' ? 'Écarté' : 'Classé'}</Badge>
                  <span className="mt-0.5 block text-xs text-slate-400">{formatDate(d.decidedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
