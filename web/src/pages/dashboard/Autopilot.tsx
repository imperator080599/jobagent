// Bandeau AUTOPILOT du tableau de bord : état, envois automatiques, interventions demandées.
import { useQuery } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { Link } from 'wouter';
import { Badge, Card } from '../../components/ui';
import { get } from '../../lib/api';
import { useSetting } from '../../lib/hooks';

interface Metrics {
  attempts: number;
  averageAutoFillRate: number | null;
  submittedApplications: number;
  submittedWithoutIntervention: number;
  shareWithoutIntervention: number | null;
  averageRunSeconds: number | null;
  blocked: number;
  interventionReasons: Record<string, number>;
  confirmedSubmissions: number;
  uncertain: number;
  failures: number;
}

const REASONS: Record<string, string> = { captcha: 'CAPTCHA', login: 'compte candidat', otp: 'code de vérification', legal: 'déclaration', validation: 'réponse refusée', unknown_form: 'formulaire non reconnu', platform: 'plateforme sans automatisation', needs_answers: 'questions', ready_to_submit: 'envoi par vous', uncertain: 'envoi incertain', manual: 'candidature manuelle' };

export function AutopilotStrip() {
  const m = useQuery({ queryKey: ['apply', 'metrics'], queryFn: () => get<Metrics>('/apply/metrics'), refetchInterval: 60_000 });
  const s = useSetting('application.autopilot');
  if (!m.data) return null;
  const d = m.data;
  const reasons = Object.entries(d.interventionReasons).sort((a, b) => b[1] - a[1]);
  return (
    <Card className="mb-5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-slate-600">
        <span className="flex items-center gap-2 font-medium text-slate-800">
          <Rocket className="size-4 text-indigo-600" /> AUTOPILOT {s.value?.enabled ? <Badge tone="success">activé</Badge> : <Badge>désactivé</Badge>}
        </span>
        <span>
          <b className="text-slate-900">{d.submittedApplications}</b> candidature(s) envoyée(s) par le moteur{d.shareWithoutIntervention != null ? `, dont ${d.shareWithoutIntervention} % sans intervention` : ''}
        </span>
        {d.averageAutoFillRate != null && (
          <span>
            Remplissage automatique moyen : <b className="text-slate-900">{d.averageAutoFillRate} %</b>
          </span>
        )}
        {reasons.length > 0 && <span>Interventions : {reasons.slice(0, 4).map(([r, n]) => `${REASONS[r] ?? r} (${n})`).join(', ')}</span>}
        <Link href="/parametres/candidature" className="ml-auto text-indigo-700 hover:underline">
          Règles
        </Link>
      </div>
    </Card>
  );
}
