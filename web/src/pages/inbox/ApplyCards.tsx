// Centre d'exceptions du moteur de candidature : chaque carte dit exactement ce qui est
// attendu de vous, et rien de plus. Une réponse donnée ici est enregistrée une fois pour
// toutes et la candidature reprend d'elle-même.
import { useMutation } from '@tanstack/react-query';
import { CircleHelp, ExternalLink, Hand, RefreshCw, Send, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { Alert, Badge, Button, Card, Field, Input, Select, Textarea, useToast } from '../../components/ui';
import { post } from '../../lib/api';
import { errorText } from '../../lib/hooks';
import type { ActionItem } from '../Inbox';
import { SubmittedModal } from './JobReviewCard';

const PLATFORM_NAMES: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workday: 'Workday',
  workable: 'Workable',
  recruitee: 'Recruitee',
  personio: 'Personio',
  teamtailor: 'Teamtailor',
  icims: 'iCIMS',
  taleo: 'Oracle Taleo',
  successfactors: 'SAP SuccessFactors',
  breezy: 'Breezy HR',
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  wttj: 'Welcome to the Jungle',
  generic: "Site carrières de l'entreprise",
};

const REASONS: Record<string, string> = {
  ready: 'Prête à envoyer',
  captcha: 'Contrôle anti-robots',
  login: 'Compte candidat',
  otp: 'Code de vérification',
  legal: 'Déclaration à cocher',
  validation: 'Réponse refusée par la page',
  unknown_form: 'Formulaire non reconnu',
  platform: 'Plateforme sans automatisation',
  technical: 'Incident technique',
};

const SCOPES = [
  { id: 'general', label: 'Toutes mes candidatures' },
  { id: 'country', label: 'Ce pays' },
  { id: 'company', label: 'Cette entreprise' },
  { id: 'job', label: 'Cette offre seulement' },
] as const;

interface Question {
  key: string;
  label: string;
  question: string;
  scope: 'general' | 'country' | 'company' | 'job';
  options: { value: string; label: string }[];
  reason: string;
  suggestion: string;
  sensitive: boolean;
}

function Shell({ icon, badge, tone, item, children }: { icon: React.ReactNode; badge: string; tone: 'brand' | 'warning' | 'danger' | 'info' | 'success'; item: ActionItem; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone}>{badge}</Badge>
            {item.body?.platform && <Badge>{PLATFORM_NAMES[item.body.platform] ?? item.body.platform}</Badge>}
          </div>
          <p className="mt-1 text-sm font-semibold text-slate-900">{item.jobId ? <Link href={`/offres/${item.jobId}`} className="hover:underline">{item.title}</Link> : item.title}</p>
          {children}
        </div>
      </div>
    </Card>
  );
}

export function QuestionsCard({ item, onDone }: { item: ActionItem; onDone: () => void }) {
  const toast = useToast();
  const questions = (item.body?.questions ?? []) as Question[];
  const [answers, setAnswers] = useState<Record<string, { answer: string; scope: Question['scope'] }>>(() => Object.fromEntries(questions.map((q) => [q.key, { answer: q.suggestion ?? '', scope: q.scope }])));
  const set = (key: string, patch: Partial<{ answer: string; scope: Question['scope'] }>) => setAnswers((a) => ({ ...a, [key]: { ...a[key]!, ...patch } }));
  const m = useMutation({
    mutationFn: () =>
      post<{ saved: number }>(`/apply/${item.jobId}/answers`, {
        answers: questions.map((q) => ({ label: q.label, question: q.question, answer: answers[q.key]?.answer ?? '', scope: answers[q.key]?.scope ?? q.scope, sensitive: q.sensitive })).filter((a) => a.answer.trim()),
      }),
    onSuccess: (r) => {
      toast(`${r.saved} réponse(s) enregistrée(s) : la candidature reprend, rien n’est à ressaisir.`, 'success');
      onDone();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const complete = questions.every((q) => (answers[q.key]?.answer ?? '').trim());
  return (
    <Shell icon={<CircleHelp className="size-4" />} badge="Questions de formulaire" tone="warning" item={item}>
      <p className="mt-0.5 text-[13px] text-slate-600">
        {item.body?.filled ?? 0} champ(s) déjà remplis automatiquement. Ces questions ne figurent pas dans votre profil : répondez une fois, la réponse sera réutilisée, même formulée autrement.
      </p>
      <div className="mt-3 space-y-3">
        {questions.map((q) => (
          <div key={q.key} className="rounded-lg border border-slate-200 p-3">
            <p className="text-[13px] font-medium text-slate-800">
              {q.label} {q.sensitive && <Badge tone="warning">Donnée sensible</Badge>}
            </p>
            {q.reason && <p className="text-xs text-slate-500">{q.reason}</p>}
            <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px]">
              {q.options.filter((o) => o.label.trim() && !/^(please select|select|choisir|--)/i.test(o.label)).length ? (
                <Select value={answers[q.key]?.answer ?? ''} onChange={(e) => set(q.key, { answer: e.target.value })} aria-label={q.label}>
                  <option value="">Choisir…</option>
                  {q.options
                    .filter((o) => o.label.trim() && !/^(please select|select|choisir|--)/i.test(o.label))
                    .map((o) => (
                      <option key={o.value} value={o.label}>
                        {o.label}
                      </option>
                    ))}
                </Select>
              ) : q.label.length > 80 || /pourquoi|why|motivation/i.test(q.label) ? (
                <Textarea rows={3} value={answers[q.key]?.answer ?? ''} onChange={(e) => set(q.key, { answer: e.target.value })} aria-label={q.label} />
              ) : (
                <Input value={answers[q.key]?.answer ?? ''} onChange={(e) => set(q.key, { answer: e.target.value })} aria-label={q.label} placeholder={q.suggestion ? `Proposé : ${q.suggestion}` : ''} />
              )}
              <Select value={answers[q.key]?.scope ?? q.scope} onChange={(e) => set(q.key, { scope: e.target.value as Question['scope'] })} aria-label="Portée de la réponse">
                {SCOPES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Send className="size-4" />} disabled={!complete} loading={m.isPending} onClick={() => m.mutate()}>
          Enregistrer et reprendre la candidature
        </Button>
      </div>
    </Shell>
  );
}

export function HandoffCard({ item, onDone }: { item: ActionItem; onDone: () => void }) {
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const relaunch = useMutation({ mutationFn: () => post(`/apply/${item.jobId}/run`, {}), onSuccess: () => toast('Candidature relancée.', 'success'), onError: (e) => toast(errorText(e), 'danger') });
  const b = item.body ?? {};
  return (
    <Shell icon={<Hand className="size-4" />} badge={REASONS[b.reason] ?? 'Intervention'} tone={b.reason === 'ready' ? 'success' : 'warning'} item={item}>
      <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{b.text}</p>
      {b.detail && ['validation', 'unknown_form', 'technical', 'legal'].includes(b.reason) && <p className="mt-1 text-xs text-slate-500">{b.detail}</p>}
      <p className="mt-1 text-xs text-slate-500">{b.filled ?? 0} champ(s) sur {b.total ?? 0} remplis automatiquement.</p>
      {Array.isArray(b.human) && b.human.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-[12.5px] text-slate-600">
          {b.human.map((h: { label: string; reason: string }, i: number) => (
            <li key={i}>
              {h.label} — {h.reason}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {b.url && (
          <a href={b.url} target="_blank" rel="noreferrer">
            <Button size="sm" variant="primary" icon={<ExternalLink className="size-4" />}>
              Ouvrir le formulaire
            </Button>
          </a>
        )}
        <Button size="sm" icon={<Send className="size-4" />} onClick={() => setSent(true)}>
          J'ai envoyé la candidature
        </Button>
        {b.reason !== 'ready' && (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} loading={relaunch.isPending} onClick={() => relaunch.mutate()}>
            Relancer après mon intervention
          </Button>
        )}
      </div>
      <p className="mt-2 text-[11.5px] text-slate-400">Avec l’extension JobAgent, le formulaire se remplit à l’identique dans votre navigateur ; la confirmation est enregistrée après votre envoi.</p>
      {item.jobId && <SubmittedModal jobId={item.jobId} open={sent} onClose={() => setSent(false)} onDone={onDone} />}
    </Shell>
  );
}

export function VerifyCard({ item, onDone }: { item: ActionItem; onDone: () => void }) {
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const retry = useMutation({
    mutationFn: () => post(`/apply/${item.jobId}/run`, { afterVerification: true }),
    onSuccess: () => {
      toast('Nouvelle tentative lancée.', 'success');
      onDone();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  return (
    <Shell icon={<ShieldQuestion className="size-4" />} badge="Envoi à vérifier" tone="danger" item={item}>
      <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{item.body?.text}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => setSent(true)}>
          Elle est bien partie
        </Button>
        <Button size="sm" icon={<RefreshCw className="size-4" />} loading={retry.isPending} onClick={() => retry.mutate()}>
          Elle n’est pas partie : réessayer
        </Button>
      </div>
      {item.jobId && <SubmittedModal jobId={item.jobId} open={sent} onClose={() => setSent(false)} onDone={onDone} />}
    </Shell>
  );
}

export function ManualCard({ item, onDone }: { item: ActionItem; onDone: () => void }) {
  const [sent, setSent] = useState(false);
  const b = item.body ?? {};
  const evidence = Array.isArray(b.evidence) ? b.evidence[0] : null;
  return (
    <Shell icon={<ShieldAlert className="size-4" />} badge="À faire vous-même" tone="info" item={item}>
      <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{b.text}</p>
      {Array.isArray(b.limits) && b.limits.map((l: string, i: number) => <p key={i} className="mt-1 text-xs text-slate-500">{l}</p>)}
      {evidence && (
        <Alert tone="neutral">
          <span className="text-[12px]">
            « {evidence.quote} » —{' '}
            <a href={evidence.url} target="_blank" rel="noreferrer" className="underline">
              source
            </a>{' '}
            (vérifié le {evidence.checkedAt})
          </span>
        </Alert>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {b.url && (
          <a href={b.url} target="_blank" rel="noreferrer">
            <Button size="sm" variant="primary" icon={<ExternalLink className="size-4" />}>
              Ouvrir l'offre
            </Button>
          </a>
        )}
        {item.jobId && (
          <Link href={`/offres/${item.jobId}`}>
            <Button size="sm">Documents et réponses préparés</Button>
          </Link>
        )}
        <Button size="sm" icon={<Send className="size-4" />} onClick={() => setSent(true)}>
          J'ai postulé
        </Button>
      </div>
      {item.jobId && <SubmittedModal jobId={item.jobId} open={sent} onClose={() => setSent(false)} onDone={onDone} />}
    </Shell>
  );
}
