import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleCheck, Clock, Inbox as InboxIcon, X } from 'lucide-react';
import { Link } from 'wouter';
import { Badge, Button, Card, EmptyState, IconButton, Loading, PageHeader, useToast } from '../components/ui';
import { get, post } from '../lib/api';
import { relativeTime } from '../lib/format';
import { errorText } from '../lib/hooks';
import { JobReviewCard } from './inbox/JobReviewCard';

export interface ActionItem {
  id: string;
  type: string;
  title: string;
  body: any;
  jobId: string | null;
  priority: number;
  createdAt: string;
}

const TYPE_LABELS: Record<string, { label: string; tone: 'brand' | 'warning' | 'info' | 'neutral' | 'danger' | 'success' }> = {
  'setup.cv_master': { label: 'Démarrage', tone: 'brand' },
  'setup.llm_key': { label: 'Démarrage', tone: 'brand' },
  'setup.ats_prompt': { label: 'Démarrage', tone: 'brand' },
  'setup.search': { label: 'Démarrage', tone: 'brand' },
  'setup.letter_template': { label: 'Démarrage', tone: 'brand' },
  'cv.master.review': { label: 'CV master', tone: 'warning' },
  'fact.conflict': { label: 'Information à confirmer', tone: 'warning' },
  'linkedin.diffs': { label: 'LinkedIn', tone: 'info' },
  'job.review': { label: 'Offre à décider', tone: 'brand' },
  'job.question': { label: 'Question', tone: 'warning' },
  'document.review': { label: 'Document à valider', tone: 'warning' },
  'application.authorize': { label: 'Candidature à autoriser', tone: 'success' },
  'application.blocked': { label: 'Intervention requise', tone: 'danger' },
  'application.question': { label: 'Question de formulaire', tone: 'warning' },
  'email.review': { label: 'Email', tone: 'info' },
  'interview.detected': { label: 'Entretien', tone: 'success' },
  'followup.due': { label: 'Relance', tone: 'info' },
  'system.alert': { label: 'Alerte', tone: 'danger' },
};

function linkFor(item: ActionItem): string | null {
  if (item.body?.link) return item.body.link;
  if (item.type === 'cv.master.review') return '/profil/cv';
  if (item.type === 'fact.conflict') return '/profil/informations';
  if (item.jobId) return `/offres/${item.jobId}`;
  return null;
}

export function InboxPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['inbox'], queryFn: () => get<{ items: ActionItem[] }>('/inbox'), refetchInterval: 20_000 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inbox'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'dismiss' | 'done' | 'snooze' }) => post(`/inbox/${v.id}/${v.action}`, v.action === 'snooze' ? { hours: 24 } : {}),
    onSuccess: refresh,
    onError: (e) => toast(errorText(e), 'danger'),
  });

  if (q.isLoading) return <Loading />;
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader title="À valider" description="Tout ce qui attend une décision de votre part, au même endroit. Le reste avance sans vous." />
      {items.length === 0 ? (
        <Card>
          <EmptyState icon={<CircleCheck className="size-5 text-emerald-600" />} title="Rien à traiter" description="L'agent travaille. Vous serez prévenu dès qu'une décision sera nécessaire." />
        </Card>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            if (item.type === 'job.review' || item.type === 'application.validate' || item.type === 'application.submit') {
              return (
                <li key={item.id}>
                  <JobReviewCard item={item} onDone={refresh} />
                </li>
              );
            }
            const meta = TYPE_LABELS[item.type] ?? { label: 'Action', tone: 'neutral' as const };
            const href = linkFor(item);
            return (
              <li key={item.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                      <InboxIcon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        <span className="text-xs text-slate-400">{relativeTime(item.createdAt)}</span>
                      </div>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{item.title}</p>
                      {item.body?.text && <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{item.body.text}</p>}
                      {Array.isArray(item.body?.examples) && (
                        <ul className="mt-1 list-disc pl-5 text-[13px] text-slate-600">
                          {item.body.examples.map((e: string, i: number) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      )}
                      {item.type === 'fact.conflict' && (
                        <p className="mt-0.5 text-[13px] text-slate-600">
                          Valeur actuelle : « {String(item.body.current)} » · proposée : « {String(item.body.proposed)} »
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {href && (
                          <Link href={href}>
                            <Button size="sm" variant="primary" icon={<ArrowRight className="size-4" />}>
                              Traiter
                            </Button>
                          </Link>
                        )}
                        <Button size="sm" variant="ghost" icon={<Clock className="size-4" />} onClick={() => act.mutate({ id: item.id, action: 'snooze' })}>
                          Demain
                        </Button>
                      </div>
                    </div>
                    <IconButton label="Écarter" onClick={() => act.mutate({ id: item.id, action: 'dismiss' })}>
                      <X className="size-4" />
                    </IconButton>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
