import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CircleCheck, Circle } from 'lucide-react';
import { Link } from 'wouter';
import { Button, Card, CardHeader, Loading, PageHeader } from '../components/ui';
import { get } from '../lib/api';
import { useAuthStatus } from '../lib/hooks';
import { AutopilotStrip } from './dashboard/Autopilot';
import { DashboardStats } from './dashboard/Stats';

interface Summary {
  masters: { id: string; language: string }[];
  masterDrafts: { id: string }[];
  atsPrompt: { isDefault: boolean; version: number } | null;
  missingFacts: { key: string; label: string }[];
  llm: { available: boolean; provider: string };
}

export function DashboardPage() {
  const status = useAuthStatus();
  const summary = useQuery({ queryKey: ['profile-summary'], queryFn: () => get<Summary>('/profile/summary') });
  const counts = useQuery({ queryKey: ['overview', 'counts'], queryFn: () => get<{ inbox: number; working: number }>('/overview/counts') });
  if (summary.isLoading || !summary.data) return <Loading />;
  const s = summary.data;
  const steps = [
    { done: s.masters.length > 0, label: 'Importer et valider votre CV master', hint: s.masterDrafts.length ? 'Un brouillon attend votre relecture.' : 'PDF, Word ou texte.', href: '/profil/cv' },
    { done: s.llm.available, label: "Ajouter votre clé d'API Anthropic", hint: "Indispensable à l'analyse ATS et à la rédaction.", href: '/parametres/ia' },
    { done: Boolean(s.atsPrompt && !s.atsPrompt.isDefault), label: 'Coller votre prompt ATS personnel', hint: 'Un prompt par défaut est utilisé en attendant.', href: '/profil/prompt-ats' },
    { done: s.missingFacts.length === 0, label: 'Compléter vos informations de candidature', hint: s.missingFacts.length ? `${s.missingFacts.length} information(s) fréquemment demandée(s) à renseigner.` : '', href: '/profil/informations' },
  ];
  const remaining = steps.filter((x) => !x.done).length;
  const first = status.data?.user?.name?.split(' ')[0];

  return (
    <>
      <PageHeader
        title={first ? `Bonjour ${first}` : 'Pilotage'}
        description="Ce que l'agent a trouvé, préparé et envoyé — et ce qui attend votre décision."
        actions={
          !!counts.data?.inbox && (
            <Link href="/validation">
              <Button variant="primary" icon={<ArrowRight className="size-4" />}>
                {counts.data.inbox} action(s) à valider
              </Button>
            </Link>
          )
        }
      />
      {remaining > 0 && (
        <Card className="mb-5">
          <CardHeader title="Mise en route" description={`${steps.length - remaining} étape(s) sur ${steps.length} terminée(s). Quelques minutes suffisent, une seule fois.`} />
          <ul className="divide-y divide-slate-100 px-5 pb-2">
            {steps.map((step) => (
              <li key={step.label} className="flex items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-start gap-3">
                  {step.done ? <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 size-5 shrink-0 text-slate-300" />}
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${step.done ? 'text-slate-400 line-through' : 'text-slate-900'}`}>{step.label}</p>
                    {!step.done && step.hint && <p className="text-[13px] text-slate-500">{step.hint}</p>}
                  </div>
                </div>
                {!step.done && (
                  <Link href={step.href}>
                    <Button size="sm">Ouvrir</Button>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <AutopilotStrip />
      <DashboardStats />
    </>
  );
}
