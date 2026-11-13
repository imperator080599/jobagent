// Suivi : ce que disent les réponses reçues, ce qui attend une réponse de votre part,
// les relances dues et les entretiens à venir.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Mail, MailQuestion, PenLine, Send } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Textarea, type Tone, useToast } from '../components/ui';
import { get, post, put } from '../lib/api';
import { formatDate, relativeTime } from '../lib/format';
import { errorText } from '../lib/hooks';

interface MailRow {
  id: string;
  fromName: string;
  fromAddr: string;
  subject: string;
  date: string | null;
  snippet: string;
  category: string;
  label: string;
  summary: string;
  jobId: string | null;
  jobTitle: string | null;
  companyName: string | null;
  needsReview: boolean;
}
interface DraftRow {
  id: string;
  kind: string;
  jobId: string | null;
  toAddr: string;
  subject: string;
  body: string;
  jobTitle: string | null;
  companyName: string | null;
}
interface Overview {
  emails: MailRow[];
  drafts: DraftRow[];
  followUps: { jobId: string; title: string; companyName: string; submittedAt: string | null; followUpDueAt: string | null }[];
  interviews: { id: string; jobId: string; jobTitle: string; companyName: string; scheduledAt: string | null; status: string; interviewer: string }[];
}

const TONES: Record<string, Tone> = { confirmation: 'success', interview: 'brand', rejection: 'danger', offer: 'success', recruiter_request: 'warning', other: 'neutral' };
const CATEGORIES: [string, string][] = [['confirmation', 'Accusé de réception'], ['interview', "Proposition d'entretien"], ['rejection', 'Refus'], ['offer', "Proposition d'embauche"], ['recruiter_request', 'Demande du recruteur'], ['other', 'Sans rapport']];

function DraftModal({ draft, canCompose, onClose }: { draft: DraftRow | null; canCompose: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState('');
  if (draft && loaded !== draft.id) {
    setLoaded(draft.id);
    setTo(draft.toAddr);
    setSubject(draft.subject);
    setBody(draft.body);
  }
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['mail'] });
    onClose();
  };
  const onError = (e: unknown) => toast(errorText(e), 'danger');
  const save = useMutation({ mutationFn: () => put(`/mail/drafts/${draft!.id}`, { toAddr: to, subject, body }), onError });
  const push = useMutation({ mutationFn: async () => { await save.mutateAsync(); return post(`/mail/drafts/${draft!.id}/push`); }, onSuccess: () => { toast('Brouillon déposé dans Gmail : relisez-le puis envoyez-le depuis votre messagerie.', 'success'); done(); }, onError });
  const discard = useMutation({ mutationFn: () => post(`/mail/drafts/${draft!.id}/discard`), onSuccess: done, onError });
  const copy = async () => {
    await navigator.clipboard.writeText(`${subject}\n\n${body}`);
    toast('Texte copié.');
  };
  return (
    <Modal
      open={Boolean(draft)}
      onClose={onClose}
      wide
      title={draft?.kind === 'follow_up' ? 'Relance préparée' : 'Réponse préparée'}
      footer={
        <>
          <Button variant="ghost" onClick={() => discard.mutate()}>Écarter</Button>
          <Button onClick={copy}>Copier le texte</Button>
          <Button variant="primary" icon={<Send className="size-4" />} disabled={!canCompose || !to.trim()} loading={push.isPending} title={canCompose ? undefined : "Autorisez la rédaction de brouillons dans Paramètres → Messagerie"} onClick={() => push.mutate()}>Déposer dans mes brouillons Gmail</Button>
        </>
      }
    >
      <div className="space-y-3">
        {body.includes('[à compléter]') && <Alert tone="warning">Ce brouillon contient une mention « [à compléter] » : une information demandée ne figure pas dans votre profil.</Alert>}
        <Field label="Destinataire"><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="adresse du recruteur" /></Field>
        <Field label="Objet"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Message"><Textarea rows={11} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <p className="text-[12px] text-slate-500">Rien n'est envoyé d'ici : le message est déposé dans vos brouillons, ou copié, et c'est vous qui l'envoyez.</p>
      </div>
    </Modal>
  );
}

function AssignModal({ mail, onClose }: { mail: MailRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const apps = useQuery({ queryKey: ['applications'], queryFn: () => get<{ items: { jobId: string; title: string; companyName: string }[] }>('/applications'), enabled: Boolean(mail) });
  const [jobId, setJobId] = useState('');
  const [category, setCategory] = useState('confirmation');
  const [loaded, setLoaded] = useState('');
  if (mail && loaded !== mail.id) {
    setLoaded(mail.id);
    setJobId(mail.jobId ?? '');
    setCategory(mail.category === 'job_alert' ? 'other' : mail.category);
  }
  const assign = useMutation({
    mutationFn: () => post(`/mail/emails/${mail!.id}/assign`, { jobId: jobId || null, category }),
    onSuccess: () => {
      toast('Email classé.', 'success');
      void qc.invalidateQueries({ queryKey: ['mail'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      onClose();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  return (
    <Modal open={Boolean(mail)} onClose={onClose} title="Rattacher cet email" footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button variant="primary" loading={assign.isPending} onClick={() => assign.mutate()}>Valider</Button></>}>
      {mail && (
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 p-3 text-[13px]">
            <p className="font-medium text-slate-900">{mail.subject || '(sans objet)'}</p>
            <p className="text-slate-500">{mail.fromName || mail.fromAddr} · {formatDate(mail.date, true)}</p>
            <p className="mt-1 text-slate-700">{mail.summary || mail.snippet}</p>
          </div>
          <Field label="Candidature concernée">
            <Select value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">Aucune</option>
              {(apps.data?.items ?? []).map((a) => <option key={a.jobId} value={a.jobId}>{a.companyName} — {a.title}</option>)}
            </Select>
          </Field>
          <Field label="Nature du message" hint="Le suivi de la candidature est mis à jour en conséquence.">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </Select>
          </Field>
        </div>
      )}
    </Modal>
  );
}

export function TrackingPage() {
  const q = useQuery({ queryKey: ['mail', 'overview'], queryFn: () => get<Overview>('/mail/overview'), refetchInterval: 30_000 });
  const status = useQuery({ queryKey: ['mail', 'status'], queryFn: () => get<{ gmail: { connected: boolean; canCompose: boolean } }>('/mail/status') });
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [assign, setAssign] = useState<MailRow | null>(null);
  if (q.isLoading || !q.data) return <Loading />;
  const d = q.data;
  const connected = status.data?.gmail.connected ?? false;
  return (
    <>
      <PageHeader title="Suivi" description="Les réponses reçues, celles que vous devez donner, les relances et les entretiens." />
      {!connected && (
        <div className="mb-5">
          <Alert tone="info" title="Messagerie non connectée" action={<Link href="/parametres/messagerie"><Button size="sm">Connecter Gmail</Button></Link>}>
            Connectez Gmail pour que les accusés de réception, propositions d'entretien et refus mettent à jour vos candidatures d'eux-mêmes. Sans connexion, vous pouvez toujours mettre à jour chaque candidature à la main.
          </Alert>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="h-fit overflow-hidden">
          <CardHeader icon={<Mail className="size-4" />} title="Réponses reçues" description="Uniquement les messages liés à vos candidatures." />
          {d.emails.length === 0 ? (
            <EmptyState icon={<Mail className="size-5 text-slate-400" />} title="Aucun message pour le moment" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.emails.map((m) => (
                <li key={m.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TONES[m.category] ?? 'neutral'}>{m.label}</Badge>
                    {m.needsReview && <Badge tone="warning">À vérifier</Badge>}
                    <span className="text-[12px] text-slate-400">{relativeTime(m.date)}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-slate-900">{m.subject || '(sans objet)'}</p>
                  <p className="text-[12.5px] text-slate-500">{m.fromName || m.fromAddr}{m.jobId && <> · <Link href={`/offres/${m.jobId}`} className="underline">{m.companyName} — {m.jobTitle}</Link></>}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{m.summary || m.snippet}</p>
                  <button type="button" className="mt-1.5 text-[12.5px] font-medium text-indigo-600 hover:underline" onClick={() => setAssign(m)}>{m.needsReview ? 'Rattacher à une candidature' : 'Corriger le classement'}</button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader icon={<CalendarClock className="size-4" />} title="Entretiens" />
            {d.interviews.length === 0 ? (
              <p className="px-5 pb-4 text-[13px] text-slate-500">Aucun entretien en vue.</p>
            ) : (
              <ul className="space-y-2 px-5 pb-4 text-[13px]">
                {d.interviews.map((i) => (
                  <li key={i.id}>
                    <Link href={`/offres/${i.jobId}`} className="font-medium text-slate-900 hover:underline">{i.companyName} — {i.jobTitle}</Link>
                    <p className="text-slate-500">{i.scheduledAt ? formatDate(i.scheduledAt, true) : 'Date à fixer'}{i.interviewer ? ` · ${i.interviewer}` : ''}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader icon={<PenLine className="size-4" />} title="Brouillons à relire" description="Réponses et relances préparées. Rien n'est envoyé sans vous." />
            {d.drafts.length === 0 ? (
              <p className="px-5 pb-4 text-[13px] text-slate-500">Aucun brouillon en attente.</p>
            ) : (
              <ul className="divide-y divide-slate-100 pb-1">
                {d.drafts.map((x) => (
                  <li key={x.id} className="flex items-center gap-3 px-5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-slate-900">{x.kind === 'follow_up' ? 'Relance' : 'Réponse'} — {x.companyName ?? ''}</p>
                      <p className="truncate text-[12px] text-slate-500">{x.subject}</p>
                    </div>
                    <Button size="sm" onClick={() => setDraft(x)}>Relire</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {d.followUps.length > 0 && (
            <Card>
              <CardHeader icon={<MailQuestion className="size-4" />} title="Relances à envisager" />
              <ul className="space-y-2 px-5 pb-4 text-[13px]">
                {d.followUps.map((f) => (
                  <li key={f.jobId}>
                    <Link href={`/offres/${f.jobId}`} className="font-medium text-slate-900 hover:underline">{f.companyName} — {f.title}</Link>
                    <p className="text-slate-500">Envoyée le {formatDate(f.submittedAt)}, sans réponse depuis.</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
      <DraftModal draft={draft} canCompose={status.data?.gmail.canCompose ?? false} onClose={() => setDraft(null)} />
      <AssignModal mail={assign} onClose={() => setAssign(null)} />
    </>
  );
}
