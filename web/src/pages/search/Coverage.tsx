// Matrice de couverture : ce qui est réellement lu, comment, quand, avec quelles limites.
import { useQuery } from '@tanstack/react-query';
import { Radar } from 'lucide-react';
import { Badge, Card, CardHeader, Loading, type Tone } from '../../components/ui';
import { get } from '../../lib/api';
import { formatDate } from '../../lib/format';

interface Row {
  id: string;
  name: string;
  category: 'ats' | 'aggregator' | 'job_board' | 'finance' | 'public' | 'directory';
  method: string;
  status: 'operational' | 'configured_untested' | 'error' | 'not_configured' | 'unavailable' | 'alerts_waiting';
  statusLabel: string;
  sources: number;
  liveJobs: number;
  lastSuccessAt: string | null;
  lastError: string;
  incomplete: string;
  limits: string[];
  evidence: { url: string; quote: string; checkedAt: string }[];
}

const TONE: Record<Row['status'], Tone> = { operational: 'success', configured_untested: 'warning', error: 'danger', not_configured: 'neutral', unavailable: 'neutral', alerts_waiting: 'info' };
const CATEGORY: Record<Row['category'], string> = { ats: 'Sites carrières (ATS)', job_board: 'Sites d’emploi', finance: 'Finance', aggregator: 'Agrégateurs', public: 'Services publics et flux', directory: 'Annuaire' };

export function CoverageTab() {
  const q = useQuery({ queryKey: ['search', 'coverage-matrix'], queryFn: () => get<{ rows: Row[]; companies: Record<string, number>; note: string }>('/search/coverage-matrix'), refetchInterval: 60_000 });
  if (q.isLoading || !q.data) return <Loading />;
  const groups = (Object.keys(CATEGORY) as Row['category'][]).map((c) => ({ c, rows: q.data!.rows.filter((r) => r.category === c) })).filter((g) => g.rows.length);
  const co = q.data.companies;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader icon={<Radar className="size-4" />} title="Couverture des sources" description={q.data.note} />
        <p className="px-5 pb-4 text-[12.5px] text-slate-600">
          Annuaire des employeurs : <b>{co.found ?? 0}</b> site(s) carrières suivi(s), <b>{co.ambiguous ?? 0}</b> à confirmer, <b>{co.not_found ?? 0}</b> introuvable(s) automatiquement, <b>{co.unknown ?? 0}</b> en attente de recherche.
        </p>
      </Card>
      {groups.map((g) => (
        <Card key={g.c} className="overflow-hidden">
          <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-[12px] font-semibold text-slate-600">{CATEGORY[g.c]}</p>
          <ul className="divide-y divide-slate-100">
            {g.rows.map((r) => (
              <li key={r.id} className="px-4 py-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{r.name}</span>
                  <Badge tone={TONE[r.status]}>{r.statusLabel}</Badge>
                  {r.sources > 0 && !r.id.startsWith('alerts:') && (
                    <span className="text-xs text-slate-500">
                      {r.sources} source(s) · {r.liveJobs} offre(s) en ligne
                    </span>
                  )}
                  {r.lastSuccessAt && <span className="text-xs text-slate-400">dernière lecture réussie {formatDate(r.lastSuccessAt, true)}</span>}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">{r.method}</p>
                {r.lastError && <p className="mt-0.5 text-xs text-rose-700">{r.lastError}</p>}
                {[...r.limits, r.incomplete].filter(Boolean).map((l) => (
                  <p key={l} className="mt-0.5 text-xs text-slate-500">
                    {l}
                  </p>
                ))}
                {r.evidence[0] && (
                  <p className="mt-0.5 text-[11.5px] text-slate-400">
                    « {r.evidence[0].quote.slice(0, 220)}
                    {r.evidence[0].quote.length > 220 ? '…' : ''} » —{' '}
                    <a className="underline" href={r.evidence[0].url} target="_blank" rel="noreferrer">
                      source
                    </a>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
