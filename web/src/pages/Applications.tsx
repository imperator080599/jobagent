// Candidatures : de la préparation des documents à la réponse de l'employeur.
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import type { Stage } from '../../../src/shared/stages';
import { Badge, Card, EmptyState, Loading, PageHeader, Tabs } from '../components/ui';
import { get } from '../lib/api';
import { formatDate, relativeTime } from '../lib/format';
import { AtsPill, StageBadge } from './jobs/shared';

interface Row {
  jobId: string;
  companyName: string;
  title: string;
  locationRaw: string;
  stage: Stage;
  stageChangedAt: string;
  atsScore: number | null;
  deadlineAt: string | null;
  channel: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  followUpDueAt: string | null;
  lastActivityAt: string | null;
}

type View = 'preparation' | 'sent' | 'interviews' | 'closed';
const VIEWS: Record<View, { label: string; stages: Stage[]; empty: string }> = {
  preparation: { label: 'En préparation', stages: ['cv_in_progress', 'letter_in_progress', 'ready_to_apply', 'applying'], empty: 'Aucune candidature en préparation. Retenez une offre dans « À valider » pour lancer la préparation de vos documents.' },
  sent: { label: 'Envoyées', stages: ['sent', 'confirmed', 'follow_up_needed', 'no_response'], empty: "Aucune candidature en attente de réponse." },
  interviews: { label: 'Entretiens', stages: ['interview_hr', 'interview_tech', 'offer'], empty: "Aucun entretien en cours." },
  closed: { label: 'Clôturées', stages: ['rejected'], empty: 'Aucune candidature clôturée.' },
};

export function ApplicationsPage() {
  const [view, setView] = useState<View>('preparation');
  const q = useQuery({ queryKey: ['applications'], queryFn: () => get<{ items: Row[] }>('/applications'), refetchInterval: 20_000 });
  if (q.isLoading) return <Loading />;
  const all = q.data?.items ?? [];
  const items = all.filter((r) => VIEWS[view].stages.includes(r.stage));
  const now = Date.now();
  return (
    <>
      <PageHeader title="Candidatures" description="Une seule candidature par offre. Une candidature n'est notée « envoyée » que lorsque vous l'avez déclarée, et « confirmée » qu'avec un accusé de réception." />
      <Tabs className="mb-3" tabs={(Object.keys(VIEWS) as View[]).map((id) => ({ id, label: VIEWS[id].label, count: all.filter((r) => VIEWS[id].stages.includes(r.stage)).length }))} value={view} onChange={setView} />
      {items.length === 0 ? (
        <Card>
          <EmptyState icon={<Send className="size-5 text-slate-400" />} title={VIEWS[view].empty} />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {items.map((r) => {
              const overdue = r.followUpDueAt && new Date(r.followUpDueAt).getTime() < now && (r.stage === 'sent' || r.stage === 'confirmed');
              return (
                <li key={r.jobId} className="relative flex items-center gap-3 px-3 py-3 hover:bg-slate-50 sm:gap-4 sm:px-4">
                  <AtsPill score={r.atsScore} decision="" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/offres/${r.jobId}`} className="block truncate text-sm font-semibold text-slate-900 after:absolute after:inset-0">{r.title}</Link>
                    <p className="truncate text-[13px] text-slate-600">{r.companyName}{r.locationRaw && <span className="text-slate-400"> · {r.locationRaw}</span>}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <StageBadge stage={r.stage} />
                      {r.submittedAt && <Badge>Envoyée le {formatDate(r.submittedAt)}{r.channel ? ` · ${r.channel}` : ''}</Badge>}
                      {overdue && <Badge tone="warning">Relance à envisager</Badge>}
                      {!r.submittedAt && r.deadlineAt && <Badge tone="warning">Date limite : {formatDate(r.deadlineAt)}</Badge>}
                    </div>
                  </div>
                  <p className="hidden shrink-0 text-[12px] text-slate-400 sm:block">{relativeTime(r.lastActivityAt ?? r.stageChangedAt)}</p>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
