// Cartes du centre de validation liées à une offre :
//  - « Offre à décider » : notes, synthèse, questions de l'agent, décision ;
//  - « Documents à valider » : aperçus du CV et de la lettre, modifications, contrôle ;
//  - « Postuler » : documents à télécharger, lien de candidature, déclaration d'envoi.
import { useMutation } from '@tanstack/react-query';
import { ArrowUpRight, Check, CircleAlert, Download, ExternalLink, FileText, RefreshCw, Send, ShieldAlert, Sparkles, ThumbsDown, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Textarea, useToast } from '../../components/ui';
import { post } from '../../lib/api';
import { cx, formatDate } from '../../lib/format';
import { errorText } from '../../lib/hooks';
import { AtsPill, ScoreBar, fileUrl } from '../jobs/shared';
import type { ActionItem } from '../Inbox';

type Answer = { has: boolean | null; context: string };

/** Formulaire de précisions : réponses aux questions de l'agent et consigne libre avec sa portée. */
export function FeedbackForm({ questions, onChange, stacked }: { questions: { keyword: string }[]; stacked?: boolean; onChange: (v: { skills: { name: string; has: boolean; context?: string }[]; note: string; noteScope: 'application' | 'profile' | 'style' }) => void }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<'application' | 'profile' | 'style'>('application');
  const emit = (a: Record<string, Answer>, n: string, s: typeof scope) =>
    onChange({ skills: Object.entries(a).filter(([, v]) => v.has !== null).map(([name, v]) => ({ name, has: v.has as boolean, context: v.context.trim() || undefined })), note: n, noteScope: s });
  const set = (k: string, patch: Partial<Answer>) => {
    const next = { ...answers, [k]: { ...(answers[k] ?? { has: null, context: '' }), ...patch } };
    setAnswers(next);
    emit(next, note, scope);
  };
  return (
    <div className="space-y-3">
      {questions.length > 0 && (
        <div>
          <p className="text-[13px] font-medium text-slate-800">Ces mots-clés de l'offre n'apparaissent pas dans votre CV. Les maîtrisez-vous ?</p>
          <p className="text-[12px] text-slate-500">Vos réponses sont enregistrées une fois pour toutes : la question ne vous sera plus posée, et rien ne sera ajouté à votre CV sans votre « oui ».</p>
          <ul className="mt-2 space-y-1.5">
            {questions.map((q) => {
              const a = answers[q.keyword] ?? { has: null, context: '' };
              return (
                <li key={q.keyword} className="rounded-lg bg-slate-50 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-[13px] font-medium text-slate-800">{q.keyword}</span>
                    <div className="flex overflow-hidden rounded-lg ring-1 ring-slate-200">
                      {([['Oui', true], ['Non', false]] as const).map(([label, v]) => (
                        <button key={label} type="button" onClick={() => set(q.keyword, { has: a.has === v ? null : v })} className={cx('px-3 py-1 text-[12.5px] font-medium', a.has === v ? (v ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-white') : 'bg-white text-slate-600 hover:bg-slate-50')}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {a.has === true && <Input className="mt-2" placeholder="Dans quel contexte ? (ex. « utilisé sur trois missions chez … »)" value={a.context} onChange={(e) => set(q.keyword, { context: e.target.value })} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className={cx('grid gap-2', !stacked && 'sm:grid-cols-[1fr_auto]')}>
        <Field label="Une précision ou une consigne ?">
          <Textarea
            rows={2}
            placeholder="Ex. « insister sur mes missions pour des fonds d'investissement »"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              emit(answers, e.target.value, scope);
            }}
          />
        </Field>
        <Field label="Elle s'applique à">
          <Select
            value={scope}
            onChange={(e) => {
              const s = e.target.value as typeof scope;
              setScope(s);
              emit(answers, note, s);
            }}
          >
            <option value="application">cette candidature</option>
            <option value="profile">toutes mes candidatures</option>
            <option value="style">ma façon d'écrire</option>
          </Select>
        </Field>
      </div>
    </div>
  );
}

function ReviewCard({ item, onDone }: { item: ActionItem; onDone: () => void }) {
  const toast = useToast();
  const b = item.body ?? {};
  const [fb, setFb] = useState<{ skills: { name: string; has: boolean; context?: string }[]; note: string; noteScope: 'application' | 'profile' | 'style' }>({ skills: [], note: '', noteScope: 'application' });
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const act = useMutation({
    mutationFn: (decision: 'pursue' | 'reject' | 'reanalyze' | 'later') => post(`/jobs/${item.jobId}/review`, { decision, skills: fb.skills, note: fb.note || undefined, noteScope: fb.noteScope, reason: reason || undefined }),
    onSuccess: (_d, decision) => {
      toast(decision === 'pursue' ? 'Candidature lancée : le CV puis la lettre sont en préparation.' : decision === 'reject' ? 'Offre écartée.' : decision === 'reanalyze' ? 'Précisions enregistrées : réévaluation en cours.' : 'Reportée de trois jours.', decision === 'pursue' ? 'success' : 'neutral');
      setRejecting(false);
      onDone();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const hasInput = fb.skills.length > 0 || fb.note.trim().length > 0;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-4 p-4 sm:p-5">
        <AtsPill score={b.score ?? null} decision={b.decision ?? ''} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">Offre à décider</Badge>
            {b.strategic && <Badge tone="info"><Sparkles className="size-3" /> Stratégique</Badge>}
            {b.weak && <Badge tone="warning">Adéquation faible</Badge>}
          </div>
          <Link href={`/offres/${item.jobId}`} className="mt-1 block text-[15px] leading-snug font-semibold text-slate-900 hover:underline">
            {item.title}
          </Link>
          {b.summary && <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{b.summary}</p>}
          {b.score != null && (
            <p className="mt-1 text-[12px] text-slate-500">
              Note attribuée par votre prompt : {String(b.score).replace('.', ',')}/20
              {b.projected != null && ` · estimation du rapport après optimisation : ${String(b.projected).replace('.', ',')}/20 (non mesurée)`}
            </p>
          )}
        </div>
      </div>
      <div className="grid gap-4 border-t border-slate-100 px-4 py-3 sm:grid-cols-3 sm:px-5">
        <ScoreBar label="Pertinence" value={b.relevance ?? null} hint="Intérêt de l'opportunité pour votre carrière" />
        <ScoreBar label="Adéquation" value={b.fit ?? null} hint="Correspondance de votre profil avec les exigences" />
        <ScoreBar label="Priorité" value={b.priority ?? null} hint="Combinaison pondérée (réglable dans les paramètres)" />
      </div>
      <div className="space-y-3 border-t border-slate-100 px-4 py-4 sm:px-5">
        {b.injection && (
          <Alert tone="warning" title="Annonce à relire">
            Le texte de cette annonce contient un passage adressé à une IA. Il a été traité comme une simple donnée ; aucune action automatique n'est prise pour cette offre.
          </Alert>
        )}
        {b.scoreConflict && <Alert tone="warning">La note n'a pas pu être lue avec certitude dans le rapport : consultez-le avant de décider.</Alert>}
        {(b.strengths?.length > 0 || b.gaps?.length > 0 || b.blockers?.length > 0) && (
          <div className="grid gap-3 text-[13px] sm:grid-cols-2">
            {b.strengths?.length > 0 && (
              <div>
                <p className="font-medium text-slate-800">Vos atouts</p>
                <ul className="mt-1 space-y-0.5 text-slate-600">{b.strengths.map((s: string, i: number) => <li key={i} className="flex gap-1.5"><Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />{s}</li>)}</ul>
              </div>
            )}
            {(b.gaps?.length > 0 || b.blockers?.length > 0) && (
              <div>
                <p className="font-medium text-slate-800">Écarts</p>
                <ul className="mt-1 space-y-0.5 text-slate-600">
                  {(b.blockers ?? []).map((s: string, i: number) => <li key={`b${i}`} className="flex gap-1.5"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-rose-600" />{s}</li>)}
                  {(b.gaps ?? []).map((s: string, i: number) => <li key={i} className="flex gap-1.5"><CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />{s}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
        <FeedbackForm questions={b.questions ?? []} onChange={setFb} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3 sm:px-5">
        <Button variant="primary" icon={<Send className="size-4" />} loading={act.isPending && act.variables === 'pursue'} onClick={() => act.mutate('pursue')}>
          Préparer la candidature
        </Button>
        {hasInput && (
          <Button icon={<RefreshCw className="size-4" />} loading={act.isPending && act.variables === 'reanalyze'} onClick={() => act.mutate('reanalyze')}>
            Relancer l'analyse avec mes précisions
          </Button>
        )}
        <Button variant="ghost" icon={<ThumbsDown className="size-4" />} onClick={() => setRejecting(true)}>
          Écarter
        </Button>
        <Button variant="ghost" onClick={() => act.mutate('later')}>
          Plus tard
        </Button>
        <Link href={`/offres/${item.jobId}`} className="ml-auto inline-flex items-center gap-1 text-[13px] font-medium text-slate-500 hover:text-slate-800">
          Rapport complet <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Écarter cette offre"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)}>Annuler</Button>
            <Button variant="primary" loading={act.isPending} onClick={() => act.mutate('reject')}>Écarter</Button>
          </>
        }
      >
        <Field label="Pourquoi ? (facultatif)" hint="Votre raison affine les prochaines sélections : une offre comparable sera moins bien classée.">
          <Textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. « trop de déplacements », « secteur qui ne m'intéresse pas »" />
        </Field>
      </Modal>
    </Card>
  );
}

function Preview({ label, previewId, pdfId }: { label: string; previewId?: string | null; pdfId?: string | null }) {
  if (!previewId && !pdfId) return null;
  return (
    <a href={fileUrl(pdfId)} target="_blank" rel="noreferrer" className="group block">
      <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-slate-600">
        <FileText className="size-3.5" /> {label} <ExternalLink className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </p>
      {previewId ? (
        <img src={fileUrl(previewId)} alt={`Aperçu : ${label}`} className="w-full rounded-lg bg-white shadow-card ring-1 ring-slate-200 transition-shadow group-hover:shadow-pop" loading="lazy" />
      ) : (
        <div className="flex aspect-[210/297] items-center justify-center rounded-lg bg-white text-[12px] text-slate-400 ring-1 ring-slate-200">Ouvrir le PDF</div>
      )}
    </a>
  );
}

/** Liste des modifications apportées au CV master, avant → après. */
export function ChangeList({ changes, rejected }: { changes: any[]; rejected: any[] }) {
  const rewrites = changes.filter((c) => c.kind === 'rewrite' || c.kind === 'summary' || c.kind === 'skills');
  const orders = changes.filter((c) => c.kind === 'order');
  if (!changes.length && !rejected.length) return <p className="text-[13px] text-slate-500">Aucune modification : votre CV master est repris tel quel pour cette offre.</p>;
  return (
    <div className="space-y-2">
      {rewrites.map((c, i) => (
        <div key={i} className="rounded-lg bg-slate-50 p-2.5 text-[12.5px] leading-relaxed">
          <p className="text-slate-400 line-through decoration-slate-300">{String(c.before).replace(/\*\*/g, '')}</p>
          <p className="mt-1 text-slate-800">{String(c.after).replace(/\*\*/g, '')}</p>
          {c.why && <p className="mt-1 text-[11.5px] text-indigo-600">{c.why}</p>}
        </div>
      ))}
      {orders.length > 0 && <p className="text-[12.5px] text-slate-600">{orders.length} expérience(s) dont les puces ont été réordonnées pour faire remonter les plus utiles à cette offre.</p>}
      {rejected.length > 0 && (
        <details className="rounded-lg bg-amber-50 p-2.5 text-[12.5px] text-amber-900">
          <summary className="cursor-pointer font-medium">{rejected.length} proposition(s) refusée(s) par le contrôle de véracité</summary>
          <ul className="mt-1.5 space-y-1.5">
            {rejected.map((r, i) => (
              <li key={i}>
                <span className="line-through opacity-70">{String(r.proposed).replace(/\*\*/g, '')}</span>
                <br />
                <span className="font-medium">Motif : {r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ValidateCard({ item, onDone }: { item: ActionItem; onDone: () => void }) {
  const toast = useToast();
  const b = item.body ?? {};
  const [revise, setRevise] = useState<null | 'cv' | 'letter'>(null);
  const [instructions, setInstructions] = useState('');
  const [scope, setScope] = useState<'application' | 'profile' | 'style'>('application');
  const approve = useMutation({
    mutationFn: () => post(`/applications/${item.jobId}/approve`, {}),
    onSuccess: () => {
      toast('Documents validés. Il ne reste qu’à postuler.', 'success');
      onDone();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const ask = useMutation({
    mutationFn: () => post(`/jobs/${item.jobId}/revise`, { target: revise, instructions, scope }),
    onSuccess: () => {
      toast('Nouvelle version en préparation.', 'success');
      setRevise(null);
      setInstructions('');
      onDone();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const ats = b.ats ?? {};
  const gain = ats.before != null && ats.after != null ? Math.round((ats.after - ats.before) * 10) / 10 : null;
  return (
    <Card className="overflow-hidden">
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning">Documents à valider</Badge>
          {gain != null && <Badge tone={gain > 0 ? 'success' : gain < 0 ? 'warning' : 'neutral'}>Note ATS : {ats.before} → {ats.after}/20</Badge>}
        </div>
        <Link href={`/offres/${item.jobId}`} className="mt-1 block text-[15px] leading-snug font-semibold text-slate-900 hover:underline">
          {item.title.replace(/^Valider la candidature : /, '')}
        </Link>
        {b.problems?.length > 0 && (
          <div className="mt-3">
            <Alert tone="warning" title="Points à vérifier avant de valider">
              <ul className="list-disc pl-4">{b.problems.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul>
            </Alert>
          </div>
        )}
        {b.documentsPending && <div className="mt-3"><Alert tone="info">Les PDF sont en cours de production : les aperçus apparaîtront dans un instant.</Alert></div>}
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div className="grid grid-cols-2 gap-3">
            <Preview label="CV personnalisé" previewId={b.cvPreviewFileId} pdfId={b.cvPdfFileId} />
            <Preview label="Lettre" previewId={b.letterPreviewFileId} pdfId={b.letterPdfFileId} />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-slate-800">Ce qui change par rapport à votre CV master</p>
            <p className="mb-2 text-[12px] text-slate-500">{b.cvSummary}</p>
            <div className="scroll-thin max-h-72 overflow-y-auto pr-1">
              <ChangeList changes={b.cvChanges ?? []} rejected={b.cvRejected ?? []} />
            </div>
            {b.letterNotes && <p className="mt-3 rounded-lg bg-sky-50 p-2.5 text-[12.5px] text-sky-900">Lettre — {b.letterNotes}</p>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3 sm:px-5">
        <Button variant="primary" icon={<Check className="size-4" />} loading={approve.isPending} onClick={() => approve.mutate()}>
          Valider les documents
        </Button>
        <Button onClick={() => setRevise('cv')}>Modifier le CV</Button>
        <Button onClick={() => setRevise('letter')}>Modifier la lettre</Button>
        <Link href={`/offres/${item.jobId}`} className="ml-auto inline-flex items-center gap-1 text-[13px] font-medium text-slate-500 hover:text-slate-800">
          Détail <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
      <Modal
        open={revise !== null}
        onClose={() => setRevise(null)}
        title={revise === 'cv' ? 'Demander une nouvelle version du CV' : 'Demander une nouvelle version de la lettre'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevise(null)}>Annuler</Button>
            <Button variant="primary" loading={ask.isPending} disabled={instructions.trim().length < 3} onClick={() => ask.mutate()}>Générer</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Que faut-il changer ?" hint="La version actuelle est conservée : vous pourrez y revenir.">
            <Textarea rows={4} autoFocus value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={revise === 'cv' ? 'Ex. « ne pas reformuler la première puce », « faire remonter la mission SOX »' : 'Ex. « plus direct », « parler de ma mobilité au Luxembourg »'} />
          </Field>
          <Field label="Cette consigne s'applique à">
            <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="application">cette candidature seulement</option>
              <option value="profile">toutes mes candidatures</option>
              <option value="style">ma façon d'écrire (règle de rédaction)</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

/** Déclaration d'envoi : commune au centre de validation et à la fiche d'une offre. */
export function SubmittedModal({ jobId, open, onClose, onDone }: { jobId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [channel, setChannel] = useState("Site carrières de l'entreprise");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [proof, setProof] = useState('');
  const m = useMutation({
    mutationFn: () => post(`/applications/${jobId}/submitted`, { channel, appliedAt: new Date(`${date}T12:00:00`).toISOString(), confirmationText: proof.trim() || undefined }),
    onSuccess: () => {
      toast('Candidature enregistrée. Une relance sera proposée si aucune réponse n’arrive.', 'success');
      onClose();
      onDone();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="J'ai postulé"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Enregistrer l'envoi</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Par quel canal ?">
            <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {["Site carrières de l'entreprise", 'LinkedIn', 'Email', 'Jobboard', 'Cabinet de recrutement', 'Recommandation', 'Autre'].map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Date d'envoi">
            <Input type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Accusé de réception (facultatif)" hint="Collez le message de confirmation ou le numéro de dossier. Sans preuve, la candidature est notée « envoyée » ; avec, « confirmation reçue ».">
          <Textarea rows={3} value={proof} onChange={(e) => setProof(e.target.value)} placeholder="Ex. « Nous avons bien reçu votre candidature, réf. 12345 »" />
        </Field>
      </div>
    </Modal>
  );
}

function SubmitCard({ item, onDone }: { item: ActionItem; onDone: () => void }) {
  const b = item.body ?? {};
  const [open, setOpen] = useState(false);
  const doc = (label: string, id?: string | null) =>
    id ? (
      <a href={fileUrl(id, true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-2.5 text-[13px] font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 ring-inset hover:bg-slate-50">
        <Download className="size-3.5" /> {label}
      </a>
    ) : null;
  return (
    <Card className="overflow-hidden">
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">Prête à candidater</Badge>
          {b.deadlineAt && <Badge tone="warning">Date limite : {formatDate(b.deadlineAt)}</Badge>}
        </div>
        <Link href={`/offres/${item.jobId}`} className="mt-1 block text-[15px] leading-snug font-semibold text-slate-900 hover:underline">
          {item.title.replace(/^Postuler : /, '')}
        </Link>
        <p className="mt-1 text-[13px] text-slate-600">Vos documents sont validés. Téléchargez-les, déposez votre candidature sur le site, puis indiquez ici qu'elle est partie.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {doc('CV (PDF)', b.cvPdfFileId)}
          {doc('CV (Word)', b.cvDocxFileId)}
          {doc('Lettre (PDF)', b.letterPdfFileId)}
          {doc('Lettre (Word)', b.letterDocxFileId)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3 sm:px-5">
        {b.applyUrl && (
          <a href={b.applyUrl} target="_blank" rel="noreferrer noopener" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-slate-800">
            <ExternalLink className="size-4" /> Ouvrir l'annonce
          </a>
        )}
        <Button variant="success" icon={<Check className="size-4" />} onClick={() => setOpen(true)}>
          J'ai postulé
        </Button>
      </div>
      {item.jobId && <SubmittedModal jobId={item.jobId} open={open} onClose={() => setOpen(false)} onDone={onDone} />}
    </Card>
  );
}

export function JobReviewCard({ item, onDone }: { item: ActionItem; onDone: () => void }) {
  if (item.type === 'application.validate') return <ValidateCard item={item} onDone={onDone} />;
  if (item.type === 'application.submit') return <SubmitCard item={item} onDone={onDone} />;
  if (item.type === 'job.review') return <ReviewCard item={item} onDone={onDone} />;
  return (
    <Card className="flex items-center gap-3 p-4">
      <X className="size-4 text-slate-300" />
      <p className="flex-1 text-sm font-medium text-slate-800">{item.title}</p>
      {item.jobId && (
        <Link href={`/offres/${item.jobId}`}>
          <Button size="sm">Ouvrir</Button>
        </Link>
      )}
    </Card>
  );
}
