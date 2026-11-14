// Préparation d'entretien : générée dès qu'un entretien est détecté ou déclaré, à partir
// de l'annonce et de votre CV uniquement (aucune expérience ni aucun chiffre inventés).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare, RefreshCw } from 'lucide-react';
import { Alert, Badge, Button, Card, CardHeader, useToast } from '../../components/ui';
import { post } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { errorText } from '../../lib/hooks';

export interface Interview {
  id: string;
  kind: string;
  status: string;
  scheduledAt: string | null;
  interviewer: string;
  prepStatus: string;
  prep: null | {
    summary: string;
    companyPoints: string[];
    roleFocus: string[];
    likelyQuestions: { question: string; why: string; answerPlan: string; cvEvidence: string[] }[];
    technicalTopics: { topic: string; points: string[] }[];
    stories: { title: string; experience: string; situation: string; action: string; result: string }[];
    gapsToAddress: { gap: string; honestAnswer: string }[];
    questionsToAsk: string[];
    checklist: string[];
    removed?: string[];
    generatedAt?: string;
  };
}

const List = ({ title, items }: { title: string; items: string[] }) =>
  items.length ? (
    <div>
      <p className="text-[13px] font-semibold text-slate-800">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-slate-700">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  ) : null;

export function InterviewTab({ jobId, interviews }: { jobId: string; interviews: Interview[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const regen = useMutation({
    mutationFn: () => post(`/jobs/${jobId}/interview/prepare`, {}),
    onSuccess: () => {
      toast('Préparation relancée.', 'success');
      void qc.invalidateQueries({ queryKey: ['job', jobId] });
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const itv = interviews[0];
  if (!itv) return <Card className="p-5 text-[13px] text-slate-600">Aucun entretien pour cette offre. Dès qu’un entretien est détecté dans vos emails (ou que vous le déclarez), sa préparation est générée automatiquement.</Card>;
  const p = itv.prep;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<MessagesSquare className="size-4" />}
          title="Préparation de l’entretien"
          description={`${itv.kind === 'technical' ? 'Entretien technique' : itv.kind === 'case' ? 'Étude de cas' : 'Entretien RH'}${itv.interviewer ? ` avec ${itv.interviewer}` : ''}${itv.scheduledAt ? ` · ${formatDate(itv.scheduledAt, true)}` : ''}`}
          action={
            <Button size="sm" icon={<RefreshCw className="size-4" />} loading={regen.isPending || itv.prepStatus === 'running'} onClick={() => regen.mutate()}>
              Régénérer
            </Button>
          }
        />
        <div className="space-y-4 px-5 pb-5">
          {!p ? (
            <p className="text-[13px] text-slate-600">{itv.prepStatus === 'running' ? 'Préparation en cours…' : 'Préparation en attente.'}</p>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-slate-700">{p.summary}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <List title="Ce que dit l’annonce de l’entreprise" items={p.companyPoints} />
                <List title="Ce qui sera évalué" items={p.roleFocus} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-slate-800">Questions probables</p>
                <ul className="mt-1 space-y-2">
                  {p.likelyQuestions.map((q, i) => (
                    <li key={i} className="rounded-lg bg-slate-50 p-3 text-[13px]">
                      <p className="font-medium text-slate-900">{q.question}</p>
                      <p className="text-xs text-slate-500">{q.why}</p>
                      <p className="mt-1 text-slate-700">{q.answerPlan}</p>
                      {q.cvEvidence.length > 0 && <p className="mt-1 text-xs text-slate-500">Appui dans votre CV : {q.cvEvidence.join(' · ')}</p>}
                    </li>
                  ))}
                </ul>
              </div>
              {p.stories.length > 0 && (
                <div>
                  <p className="text-[13px] font-semibold text-slate-800">Exemples à raconter (tirés de votre CV)</p>
                  <ul className="mt-1 space-y-2">
                    {p.stories.map((s, i) => (
                      <li key={i} className="rounded-lg ring-1 ring-slate-200 p-3 text-[13px] text-slate-700">
                        <p className="font-medium text-slate-900">
                          {s.title} <Badge>{s.experience}</Badge>
                        </p>
                        <p>
                          <b>Situation</b> — {s.situation}
                        </p>
                        <p>
                          <b>Action</b> — {s.action}
                        </p>
                        <p>
                          <b>Résultat</b> — {s.result}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {p.technicalTopics.map((t, i) => (
                <List key={i} title={`À réviser : ${t.topic}`} items={t.points} />
              ))}
              {p.gapsToAddress.length > 0 && <List title="Écarts à aborder honnêtement" items={p.gapsToAddress.map((g) => `${g.gap} — ${g.honestAnswer}`)} />}
              <div className="grid gap-4 sm:grid-cols-2">
                <List title="Questions à poser" items={p.questionsToAsk} />
                <List title="Avant l’entretien" items={p.checklist} />
              </div>
              {p.removed && p.removed.length > 0 && (
                <Alert tone="info" title="Contrôle de véracité">
                  {p.removed.length} élément(s) écarté(s) car absents de votre CV.
                </Alert>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
