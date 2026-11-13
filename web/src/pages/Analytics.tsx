// Analytique : où se perdent les offres, ce qui obtient des réponses, et ce que cela coûte.
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, EmptyState, Loading, PageHeader } from '../components/ui';
import { get } from '../lib/api';
import { formatMoney } from '../lib/format';
import { ChartColumn } from 'lucide-react';

interface Analytics {
  funnel: { label: string; value: number }[];
  rates: { responseRate: number | null; interviewRate: number | null; avgAts: number | null; avgRelevance: number | null; avgFit: number | null; avgAtsWithInterview: number | null; avgAtsWithoutInterview: number | null };
  sources: { name: string; type: string; jobs: number; kept: number; applied: number }[];
  missingKeywords: { label: string; n: number }[];
  analysesCount: number;
  costs: { total: number; byPurpose: { purpose: string; usd: number; calls: number }[]; perApplication: number | null };
}

const PURPOSES: Record<string, string> = { 'ats.analyze': 'Analyses ATS (votre prompt)', 'ats.extract': 'Lecture des rapports', 'job.qualify': 'Sélection des offres', 'cv.tailor': 'CV personnalisés', 'cv.verify': 'Contrôle de véracité des CV', 'cv.structure': 'Import du CV', 'letter.write': 'Lettres', 'letter.verify': 'Contrôle de véracité des lettres', 'mail.classify': 'Classement des emails', 'mail.reply': 'Réponses préparées', 'mail.followup': 'Relances préparées', 'job.extract': "Lecture d'offres collées" };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="px-4 py-3">
      <p className="text-[12.5px] font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 text-xl font-semibold text-slate-900 tabular-nums">{value}</p>
      {hint && <p className="text-[11.5px] text-slate-400">{hint}</p>}
    </div>
  );
}

export function AnalyticsPage() {
  const q = useQuery({ queryKey: ['overview', 'analytics'], queryFn: () => get<Analytics>('/overview/analytics') });
  if (q.isLoading || !q.data) return <Loading />;
  const d = q.data;
  const max = Math.max(1, ...d.funnel.map((f) => f.value));
  const pct = (v: number | null) => (v == null ? '—' : `${v} %`);
  if (d.funnel[0]!.value === 0) {
    return (
      <>
        <PageHeader title="Analytique" description="Ce qui fonctionne dans votre recherche, chiffres à l'appui." />
        <Card><EmptyState icon={<ChartColumn className="size-5 text-slate-400" />} title="Pas encore de données" description="Les indicateurs apparaîtront dès les premières offres analysées." /></Card>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Analytique" description="Ce qui fonctionne dans votre recherche, chiffres à l'appui. Les taux n'ont de sens qu'à partir de quelques dizaines de candidatures." />
      <div className="space-y-5">
        <Card className="grid grid-cols-2 divide-slate-100 sm:grid-cols-4 sm:divide-x">
          <Stat label="Taux de réponse" value={pct(d.rates.responseRate)} hint="Entretien, offre ou refus reçu" />
          <Stat label="Taux d'entretien" value={pct(d.rates.interviewRate)} hint="Sur les candidatures envoyées" />
          <Stat label="Note ATS moyenne" value={d.rates.avgAts != null ? `${d.rates.avgAts.toLocaleString('fr-FR')}/20` : '—'} hint={d.rates.avgAtsWithInterview != null ? `${d.rates.avgAtsWithInterview.toLocaleString('fr-FR')}/20 quand un entretien a suivi` : undefined} />
          <Stat label="Coût IA par candidature" value={d.costs.perApplication != null ? formatMoney(d.costs.perApplication) : '—'} hint={`${formatMoney(d.costs.total)} au total`} />
        </Card>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Entonnoir" description="De l'offre trouvée à l'offre reçue." />
            <ul className="space-y-2.5 px-5 pb-5">
              {d.funnel.map((f) => (
                <li key={f.label}>
                  <div className="flex items-baseline justify-between text-[13px]">
                    <span className="text-slate-700">{f.label}</span>
                    <span className="font-semibold text-slate-900 tabular-nums">{f.value}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${(f.value / max) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Mots-clés le plus souvent manquants" description={`D'après vos ${d.analysesCount} dernière(s) analyse(s) ATS : ce qu'il vaut la peine de mieux formuler, ou d'acquérir.`} />
            {d.missingKeywords.length === 0 ? (
              <p className="px-5 pb-5 text-[13px] text-slate-500">Pas encore assez d'analyses.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5 px-5 pb-5">
                {d.missingKeywords.map((k) => (
                  <li key={k.label} className="rounded-md bg-slate-100 px-2 py-1 text-[12.5px] text-slate-700">
                    {k.label} <span className="font-semibold text-slate-900">×{k.n}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="overflow-hidden">
            <CardHeader title="Sources" description="D'où viennent les offres utiles." />
            <table className="w-full text-left text-[13px]">
              <thead className="bg-slate-50 text-[12px] text-slate-500"><tr><th className="px-5 py-2 font-medium">Source</th><th className="px-3 py-2 font-medium">Offres</th><th className="px-3 py-2 font-medium">Retenues</th><th className="px-3 py-2 font-medium">Candidatures</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {d.sources.map((s) => (
                  <tr key={s.name + s.type}><td className="px-5 py-2 font-medium text-slate-900">{s.name}</td><td className="px-3 py-2 tabular-nums">{s.jobs}</td><td className="px-3 py-2 tabular-nums">{s.kept}</td><td className="px-3 py-2 tabular-nums">{s.applied}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader title="Coûts de l'IA" description="Par usage, depuis le début." />
            <table className="w-full text-left text-[13px]">
              <tbody className="divide-y divide-slate-100">
                {d.costs.byPurpose.map((p) => (
                  <tr key={p.purpose}><td className="px-5 py-2 text-slate-700">{PURPOSES[p.purpose] ?? p.purpose}</td><td className="px-3 py-2 text-slate-500 tabular-nums">{p.calls} appel(s)</td><td className="px-5 py-2 text-right font-medium text-slate-900 tabular-nums">{formatMoney(p.usd)}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </>
  );
}
