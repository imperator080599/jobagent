// Candidature automatique d'une offre : mode retenu (avec chaque règle vérifiée),
// tentatives (statut, taux de remplissage, étapes, captures) et lancement.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, CircleAlert, Play } from 'lucide-react';
import { Badge, Button, Card, CardHeader, useToast } from '../../components/ui';
import { get, post } from '../../lib/api';
import { cx, formatDate } from '../../lib/format';
import { errorText } from '../../lib/hooks';
import { fileUrl } from './shared';

interface Plan {
  platform: string;
  mode: 'auto' | 'prefill' | 'manual';
  url: string;
  autopilot: boolean;
  checks: { id: string; ok: boolean; label: string }[];
}
interface Attempt {
  id: string;
  status: string;
  platform: string;
  mode: string;
  reason: string;
  error: string;
  startedAt: string;
  finishedAt: string | null;
  stats: { total?: number; ready?: number; autoRate?: number; missing?: number; human?: number; durationMs?: number } | null;
  steps: { at: string; kind: string; detail: string; screenshotFileId?: string }[];
  screenshotFileIds: string[];
}

const MODE: Record<Plan['mode'], { label: string; tone: 'success' | 'brand' | 'neutral' }> = {
  auto: { label: 'Remplissage et envoi automatiques', tone: 'success' },
  prefill: { label: 'Remplissage automatique, envoi par vous', tone: 'brand' },
  manual: { label: 'Préparation, candidature faite par vous', tone: 'neutral' },
};
const STEP: Record<string, string> = { open: 'ouverture', scan: 'lecture', fill: 'saisie', verify: 'contrôle', next: 'étape', submit: 'envoi', confirm: 'confirmé', stop: 'arrêt', error: 'erreur' };
const STATUS: Record<string, string> = {
  submitted: 'Envoyée — confirmation lue sur la page',
  ready_to_submit: 'Formulaire rempli — envoi par vous',
  needs_answers: 'Questions à compléter',
  needs_human: 'Intervention nécessaire',
  uncertain: 'Envoi incertain — à vérifier',
  failed: 'Échec technique (nouvel essai automatique)',
  manual: 'Candidature à faire vous-même',
  running: 'En cours',
  submitting: 'Envoi en cours',
  not_sent: 'Vérifiée : non partie',
};

export function AutomationPanel({ jobId, stage }: { jobId: string; stage: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ['apply', jobId, 'plan'], queryFn: () => get<Plan>(`/apply/${jobId}/plan`) });
  const attempts = useQuery({ queryKey: ['apply', jobId, 'attempts'], queryFn: () => get<{ attempts: Attempt[] }>(`/apply/${jobId}/attempts`), refetchInterval: (q) => ((q.state.data?.attempts ?? []).some((a) => a.status === 'running' || a.status === 'submitting') ? 3000 : false) });
  const run = useMutation({
    mutationFn: () => post(`/apply/${jobId}/run`, {}),
    onSuccess: () => {
      toast('Candidature lancée.', 'success');
      void qc.invalidateQueries({ queryKey: ['apply', jobId] });
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const p = plan.data;
  const canRun = ['ready_to_apply', 'applying'].includes(stage);
  return (
    <Card>
      <CardHeader
        icon={<Bot className="size-4" />}
        title="Candidature automatique"
        description={p ? `${MODE[p.mode].label}${p.autopilot ? ' · règles AUTOPILOT remplies' : ''}` : 'Analyse du formulaire…'}
        action={
          canRun && p && p.mode !== 'manual' ? (
            <Button size="sm" variant="primary" icon={<Play className="size-4" />} loading={run.isPending} onClick={() => run.mutate()}>
              {p.mode === 'auto' ? 'Lancer la candidature' : 'Remplir le formulaire'}
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-4 px-5 pb-5">
        {p && (
          <ul className="grid gap-1 text-[12.5px] sm:grid-cols-2">
            {p.checks.map((c) => (
              <li key={c.id} className="flex gap-1.5">
                {c.ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />}
                <span className={c.ok ? 'text-slate-600' : 'text-slate-800'}>{c.label}</span>
              </li>
            ))}
          </ul>
        )}
        {(attempts.data?.attempts ?? []).map((a) => (
          <details key={a.id} className="rounded-lg ring-1 ring-slate-200" open={a === attempts.data!.attempts[0]}>
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
              <Badge tone={a.status === 'submitted' ? 'success' : a.status === 'uncertain' || a.status === 'failed' ? 'danger' : a.status === 'ready_to_submit' ? 'brand' : 'warning'}>{STATUS[a.status] ?? a.status}</Badge>
              <span className="text-slate-500">{formatDate(a.startedAt, true)}</span>
              {a.stats?.total != null && (
                <span className="text-slate-500">
                  · {a.stats.ready}/{a.stats.total} champs remplis ({a.stats.autoRate} %)
                  {a.stats.durationMs ? ` · ${Math.round(a.stats.durationMs / 1000)} s` : ''}
                </span>
              )}
            </summary>
            <div className="space-y-2 border-t border-slate-100 px-3 py-2 text-[12.5px]">
              {a.error && <p className="text-slate-700">{a.error}</p>}
              <ol className="space-y-1">
                {a.steps.map((s, i) => (
                  <li key={i} className={cx('flex gap-2', s.kind === 'error' ? 'text-rose-700' : 'text-slate-600')}>
                    <span className="w-16 shrink-0 text-slate-400">{STEP[s.kind] ?? s.kind}</span>
                    <span className="min-w-0 break-words">{s.detail}</span>
                    {s.screenshotFileId && (
                      <a className="shrink-0 text-indigo-700 underline" href={fileUrl(s.screenshotFileId)} target="_blank" rel="noreferrer">
                        capture
                      </a>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </details>
        ))}
      </div>
    </Card>
  );
}
