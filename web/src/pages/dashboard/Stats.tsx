// Tableau de bord : entonnoir des candidatures, ce qui presse, activité de l'agent, budget IA.
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, CircleAlert, MailQuestion, Sparkles } from 'lucide-react';
import { Link } from 'wouter';
import { Alert, Card, CardHeader, EmptyState } from '../../components/ui';
import { get } from '../../lib/api';
import { cx, formatDate, formatMoney, relativeTime } from '../../lib/format';
import { AtsPill, StageBadge, jobPlace } from '../jobs/shared';

interface Dashboard {
  pipeline: { discovery: number; decision: number; preparation: number; submitted: number; interviews: number; offers: number; filtered: number; total: number };
  newThisWeek: number;
  sentThisWeek: number;
  top: any[];
  deadlines: any[];
  followUps: { jobId: string; title: string; companyName: string; followUpDueAt: string; submittedAt: string | null }[];
  blocked: { type: string; reason: string }[];
  llm: { todayUsd: number; monthUsd: number; monthlyBudget: number; dailyBudget: number };
  activity: { id: string; at: string; actor: string; summary: string; level: string; entityType: string; entityId: string }[];
}

const ACTORS: Record<string, string> = { user: 'Vous', system: 'Système', 'agent:qualification': 'Agent de qualification', 'agent:ats': 'Agent ATS', 'agent:cv': 'Agent CV', 'agent:letter': 'Agent lettre', 'agent:search': 'Agent de recherche', 'agent:email': 'Agent email' };
const actorName = (a: string) => ACTORS[a] ?? (a.startsWith('agent:') ? `Agent ${a.slice(6)}` : a);

export function DashboardStats() {
  const q = useQuery({ queryKey: ['overview', 'dashboard'], queryFn: () => get<Dashboard>('/overview/dashboard'), refetchInterval: 30_000 });
  if (!q.data) return null;
  const d = q.data;
  const steps: { label: string; value: number; href: string; hint: string }[] = [
    { label: 'En analyse', value: d.pipeline.discovery, href: '/offres', hint: 'Offres trouvées, en cours de notation' },
    { label: 'À décider', value: d.pipeline.decision, href: '/validation', hint: 'Attendent votre avis' },
    { label: 'En préparation', value: d.pipeline.preparation, href: '/candidatures', hint: 'CV et lettre en cours ou prêts' },
    { label: 'Envoyées', value: d.pipeline.submitted, href: '/candidatures', hint: 'Candidatures parties' },
    { label: 'Entretiens', value: d.pipeline.interviews, href: '/candidatures', hint: 'En cours' },
  ];
  const budgetUsed = d.llm.monthlyBudget > 0 ? Math.min(100, (d.llm.monthUsd / d.llm.monthlyBudget) * 100) : 0;
  return (
    <div className="space-y-5">
      {d.blocked.length > 0 && (
        <Alert tone="warning" title={`${d.blocked.length} traitement(s) en attente d'une action de votre part`}>
          {[...new Set(d.blocked.map((b) => b.reason))].slice(0, 3).map((r) => <p key={r}>{r}</p>)}
        </Alert>
      )}
      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 divide-slate-100 sm:grid-cols-5 sm:divide-x">
          {steps.map((s, i) => (
            <Link key={s.label} href={s.href} title={s.hint} className={cx('group px-4 py-4 transition-colors hover:bg-slate-50', i < steps.length - 1 && 'border-b border-slate-100 sm:border-b-0')}>
              <p className="text-[12.5px] font-medium text-slate-500">{s.label}</p>
              <p className={cx('mt-1 text-2xl font-semibold tabular-nums', s.value ? 'text-slate-900' : 'text-slate-300')}>{s.value}</p>
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 text-[12.5px] text-slate-500">
          <span><span className="font-semibold text-slate-800">{d.newThisWeek}</span> nouvelle(s) offre(s) en 7 jours</span>
          <span><span className="font-semibold text-slate-800">{d.sentThisWeek}</span> candidature(s) envoyée(s) en 7 jours</span>
          <span><span className="font-semibold text-slate-800">{d.pipeline.filtered}</span> écartée(s) (consultables)</span>
          <span className="ml-auto" title={`Aujourd'hui : ${formatMoney(d.llm.todayUsd)}`}>
            IA ce mois : <span className="font-semibold text-slate-800">{formatMoney(d.llm.monthUsd)}</span>
            {d.llm.monthlyBudget > 0 && <> sur {formatMoney(d.llm.monthlyBudget)}</>}
            <span className="ml-2 inline-block h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 align-middle"><span className={cx('block h-full rounded-full', budgetUsed > 85 ? 'bg-rose-500' : 'bg-indigo-500')} style={{ width: `${budgetUsed}%` }} /></span>
          </span>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="À traiter en priorité" description="Les offres les mieux classées qui attendent une décision ou un envoi." action={<Link href="/offres" className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-500 hover:text-slate-800">Toutes <ArrowRight className="size-3.5" /></Link>} />
          {d.top.length === 0 ? (
            <EmptyState icon={<Sparkles className="size-5 text-slate-400" />} title="Rien en attente" description="Les nouvelles offres apparaîtront ici dès qu'elles auront été analysées." />
          ) : (
            <ul className="divide-y divide-slate-100 pb-1">
              {d.top.map((j) => (
                <li key={j.id} className="relative flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50">
                  <AtsPill score={j.atsScore} decision={j.atsDecision} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/offres/${j.id}`} className="block truncate text-sm font-medium text-slate-900 after:absolute after:inset-0">{j.title}</Link>
                    <p className="truncate text-[12.5px] text-slate-500">{j.companyName}{jobPlace(j) && ` · ${jobPlace(j)}`}</p>
                  </div>
                  <StageBadge stage={j.stage} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-5">
          {(d.deadlines.length > 0 || d.followUps.length > 0) && (
            <Card>
              <CardHeader title="Échéances" />
              <ul className="space-y-2 px-5 pb-4 text-[13px]">
                {d.deadlines.map((j) => (
                  <li key={j.id} className="flex items-start gap-2">
                    <CalendarClock className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <Link href={`/offres/${j.id}`} className="min-w-0 hover:underline"><span className="font-medium text-slate-800">{j.companyName}</span> — date limite le {formatDate(j.deadlineAt)}</Link>
                  </li>
                ))}
                {d.followUps.map((f) => (
                  <li key={f.jobId} className="flex items-start gap-2">
                    <MailQuestion className="mt-0.5 size-4 shrink-0 text-sky-500" />
                    <Link href={`/offres/${f.jobId}`} className="min-w-0 hover:underline"><span className="font-medium text-slate-800">{f.companyName}</span> — sans réponse depuis l'envoi du {formatDate(f.submittedAt)} : relance à envisager</Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <CardHeader title="Activité récente" action={<Link href="/parametres/journal" className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-500 hover:text-slate-800">Journal <ArrowRight className="size-3.5" /></Link>} />
            {d.activity.length === 0 ? (
              <p className="px-5 pb-4 text-[13px] text-slate-500">Aucune activité pour le moment.</p>
            ) : (
              <ul className="space-y-2.5 px-5 pb-4">
                {d.activity.slice(0, 8).map((a) => (
                  <li key={a.id} className="flex gap-2 text-[12.5px] leading-snug">
                    {a.level !== 'info' ? <CircleAlert className={cx('mt-0.5 size-3.5 shrink-0', a.level === 'error' ? 'text-rose-500' : 'text-amber-500')} /> : <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-slate-300" />}
                    <span className="min-w-0 text-slate-700">
                      {a.summary} <span className="text-slate-400">· {actorName(a.actor)}, {relativeTime(a.at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
