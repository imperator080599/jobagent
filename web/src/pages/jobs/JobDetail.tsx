// Fiche d'une offre : notes, analyse ATS (synthèse et rapport intégral), documents
// de candidature, annonce, historique. Les actions proposées dépendent de l'étape.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CircleAlert, Copy, Download, ExternalLink, FileText, RefreshCw, Send, ShieldAlert, Sparkles, Star, ThumbsDown, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { STAGE_LABELS, type Stage } from '../../../../src/shared/stages';
import { Alert, Badge, Button, Card, CardHeader, Field, IconButton, Loading, Modal, Tabs, Textarea, useToast } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { cx, formatDate, relativeTime } from '../../lib/format';
import { errorText } from '../../lib/hooks';
import { ChangeList, FeedbackForm, SubmittedModal } from '../inbox/JobReviewCard';
import { AtsPill, Report, ScoreBar, StageBadge, contractLabel, fileUrl, jobPlace, type Job } from './shared';

interface Detail {
  job: Job;
  sightings: { id: string; url: string; firstSeenAt: string; lastSeenAt: string; goneAt: string | null; sourceName: string | null; sourceType: string | null }[];
  history: { id: string; fromStage: string; toStage: string; actor: string; reason: string; at: string }[];
  analyses: { id: string; cvVersionId: string; score: number | null; decision: string; rawOutput: string; parsed: any; model: string; createdAt: string; userNote: string }[];
  cvVersions: { id: string; label: string; status: string; version: number; changeSummary: string; checks: any; pdfFileId: string | null; docxFileId: string | null; createdAt: string }[];
  letters: { id: string; status: string; language: string; text: string; checks: any; pdfFileId: string | null; docxFileId: string | null; createdAt: string }[];
  application: any | null;
  actions: { id: string; type: string; body: any }[];
}

type Tab = 'analysis' | 'documents' | 'offer' | 'history';
const ACTORS: Record<string, string> = { user: 'Vous', system: 'Système', 'agent:qualification': 'Agent de qualification', 'agent:ats': 'Agent ATS', 'agent:cv': 'Agent CV', 'agent:letter': 'Agent lettre' };
const PRE_DECISION: Stage[] = ['new', 'to_analyze', 'analyzed', 'awaiting_feedback', 'filtered', 'abandoned'];
const PRE_SUBMIT: Stage[] = [...PRE_DECISION, 'cv_in_progress', 'letter_in_progress', 'ready_to_apply', 'applying', 'expired'];

function DocLinks({ pdf, docx }: { pdf?: string | null; docx?: string | null }) {
  return (
    <div className="flex flex-wrap gap-2">
      {pdf && (
        <a href={fileUrl(pdf)} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-2.5 text-[13px] font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 ring-inset hover:bg-slate-50">
          <FileText className="size-3.5" /> Ouvrir le PDF
        </a>
      )}
      {pdf && (
        <a href={fileUrl(pdf, true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-slate-600 hover:bg-slate-100">
          <Download className="size-3.5" /> PDF
        </a>
      )}
      {docx && (
        <a href={fileUrl(docx, true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-slate-600 hover:bg-slate-100">
          <Download className="size-3.5" /> Word
        </a>
      )}
    </div>
  );
}

function RenderChecks({ render }: { render?: { ok?: boolean | null; checks?: { id: string; ok: boolean; severity: string; message: string }[] } }) {
  if (!render) return null;
  if (render.ok == null) return <p className="text-[12.5px] text-slate-500">Le PDF n'a pas encore été produit.</p>;
  const failed = (render.checks ?? []).filter((c) => !c.ok);
  return (
    <details className={cx('rounded-lg p-2.5 text-[12.5px]', failed.length ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-800')} open={failed.length > 0}>
      <summary className="cursor-pointer font-medium">{failed.length ? `Contrôle du rendu : ${failed.length} point(s) à vérifier` : `Rendu contrôlé sur le PDF final (${(render.checks ?? []).length} vérifications)`}</summary>
      <ul className="mt-1.5 space-y-0.5">
        {(render.checks ?? []).map((c) => (
          <li key={c.id} className="flex gap-1.5">
            {c.ok ? <Check className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
            {c.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function JobDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>('analysis');
  const [analysisIndex, setAnalysisIndex] = useState(0);
  const [fb, setFb] = useState<{ skills: { name: string; has: boolean; context?: string }[]; note: string; noteScope: 'application' | 'profile' | 'style' }>({ skills: [], note: '', noteScope: 'application' });
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['job', id], queryFn: () => get<Detail>(`/jobs/${id}`), refetchInterval: 8000 });
  const pack = useQuery({ queryKey: ['job', id, 'pack'], queryFn: () => get<{ qa: { ok: boolean; checks: { id: string; ok: boolean; severity: string; message: string }[] } }>(`/applications/${id}`), enabled: tab === 'documents' });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['job', id] });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const onError = (e: unknown) => toast(errorText(e), 'danger');
  const review = useMutation({
    mutationFn: (decision: 'pursue' | 'reject' | 'reanalyze') => post(`/jobs/${id}/review`, { decision, skills: fb.skills, note: fb.note || undefined, noteScope: fb.noteScope, reason: reason || undefined }),
    onSuccess: (_d, decision) => {
      toast(decision === 'pursue' ? 'Candidature lancée : le CV puis la lettre sont en préparation.' : decision === 'reject' ? 'Offre écartée.' : 'Nouvelle analyse en cours.', decision === 'pursue' ? 'success' : 'neutral');
      setRejecting(false);
      refresh();
    },
    onError,
  });
  const analyze = useMutation({ mutationFn: () => post(`/jobs/${id}/analyze`), onSuccess: () => { toast('Analyse relancée.'); refresh(); }, onError });
  const approve = useMutation({ mutationFn: () => post(`/applications/${id}/approve`, {}), onSuccess: () => { toast('Documents validés.', 'success'); refresh(); void qc.invalidateQueries({ queryKey: ['job', id, 'pack'] }); }, onError });
  const update = useMutation({ mutationFn: (body: Record<string, unknown>) => patch(`/jobs/${id}`, body), onSuccess: refresh, onError });
  const merge = useMutation({ mutationFn: (duplicateId: string) => post(`/jobs/${id}/merge`, { duplicateId }), onSuccess: () => { toast('Offres fusionnées.', 'success'); refresh(); }, onError });
  const notDup = useMutation({ mutationFn: () => post(`/jobs/${id}/not-duplicate`), onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: () => del(`/jobs/${id}`), onSuccess: () => { toast('Offre supprimée.'); void qc.invalidateQueries({ queryKey: ['jobs'] }); navigate('/offres'); }, onError });

  const job = q.data?.job;
  useEffect(() => {
    if (job && (job.stage === 'cv_in_progress' || job.stage === 'letter_in_progress' || job.stage === 'ready_to_apply')) setTab((t) => (t === 'analysis' ? 'documents' : t));
  }, [job?.stage]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <Loading />;
  if (!q.data || !job) return <Alert tone="danger">Cette offre est introuvable. <Link href="/offres" className="underline">Retour aux offres</Link></Alert>;
  const d = q.data;
  const analysis = d.analyses[analysisIndex] ?? d.analyses[0];
  const reviewCard = d.actions.find((a) => a.type === 'job.review');
  const questions: { keyword: string }[] = reviewCard?.body?.questions ?? [];
  const cv = d.cvVersions[0];
  const letter = d.letters[0];
  const dups: { id: string; similarity: number; reason: string }[] = job.flags?.possibleDuplicates ?? [];
  const working = job.stage === 'new' || job.stage === 'to_analyze' || job.stage === 'cv_in_progress' || job.stage === 'letter_in_progress';
  const lastReason = d.history.at(-1)?.reason;
  const validated = Boolean(d.application?.authorizedAt);
  const link = job.applyUrl || job.canonicalUrl;
  const qual = job.qualification ?? {};

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/offres" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
          <ArrowLeft className="size-4" /> Offres
        </Link>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-start gap-4 p-4 sm:p-5">
          <AtsPill score={job.atsScore} decision={job.atsDecision} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <StageBadge stage={job.stage} />
              {job.strategic && <Badge tone="info"><Sparkles className="size-3" /> Stratégique</Badge>}
              {job.expiredAt && <Badge tone="warning">Plus en ligne depuis le {formatDate(job.expiredAt)}</Badge>}
              {job.deadlineAt && <Badge tone="warning">Date limite : {formatDate(job.deadlineAt)}</Badge>}
            </div>
            <h1 className="mt-1 text-lg leading-snug font-semibold text-slate-900 sm:text-xl">{job.title}</h1>
            <p className="text-sm text-slate-600">
              {job.companyName}
              {jobPlace(job) && <span className="text-slate-400"> · {jobPlace(job)}</span>}
              {contractLabel(job.contractType) && <span className="text-slate-400"> · {contractLabel(job.contractType)}</span>}
              {job.yearsMin != null && <span className="text-slate-400"> · {job.yearsMin}{job.yearsMax != null ? `–${job.yearsMax}` : '+'} ans</span>}
            </p>
            <p className="mt-0.5 text-[12px] text-slate-400">
              Vue {relativeTime(job.firstSeenAt)}
              {job.postedAt && ` · publiée le ${formatDate(job.postedAt)}`}
              {d.sightings.length > 1 && ` · ${d.sightings.length} sources`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton label={job.starred ? 'Retirer des favoris' : 'Ajouter aux favoris'} onClick={() => update.mutate({ starred: !job.starred })} className={job.starred ? 'text-amber-500' : ''}>
              <Star className="size-[18px]" fill={job.starred ? 'currentColor' : 'none'} />
            </IconButton>
            {link && (
              <a href={link} target="_blank" rel="noreferrer noopener" title="Ouvrir l'annonce" aria-label="Ouvrir l'annonce" className="inline-flex size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800">
                <ExternalLink className="size-[18px]" />
              </a>
            )}
          </div>
        </div>
        <div className="grid gap-4 border-t border-slate-100 px-4 py-3 sm:grid-cols-3 sm:px-5">
          <ScoreBar label="Pertinence" value={job.relevanceScore} hint="Intérêt de l'opportunité pour votre carrière" />
          <ScoreBar label="Adéquation" value={job.fitScore} hint="Correspondance de votre profil avec les exigences" />
          <ScoreBar label="Priorité" value={job.priorityScore} hint="Combinaison pondérée, réglable dans les paramètres" />
        </div>
        {(working || job.stage === 'filtered' || job.stage === 'abandoned') && (
          <div className="border-t border-slate-100 px-4 py-3 text-[13px] text-slate-600 sm:px-5">
            {working ? (
              <span className="inline-flex items-center gap-2 font-medium text-indigo-700">
                <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-indigo-400 opacity-75" /><span className="relative inline-flex size-2 rounded-full bg-indigo-600" /></span>
                {job.stage === 'cv_in_progress' ? 'CV personnalisé en préparation…' : job.stage === 'letter_in_progress' ? 'Lettre en cours de rédaction…' : 'Analyse en cours…'}
              </span>
            ) : (
              <>Écartée{lastReason ? ` : ${lastReason}` : ''}. Vous pouvez la rétablir à tout moment.</>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3 sm:px-5">
          {PRE_DECISION.includes(job.stage) && (
            <>
              <Button variant="primary" icon={<Send className="size-4" />} loading={review.isPending && review.variables === 'pursue'} onClick={() => review.mutate('pursue')}>Préparer la candidature</Button>
              <Button icon={<RefreshCw className="size-4" />} loading={analyze.isPending || (review.isPending && review.variables === 'reanalyze')} onClick={() => (fb.skills.length || fb.note.trim() ? review.mutate('reanalyze') : analyze.mutate())}>
                {job.atsScore == null ? "Lancer l'analyse" : "Relancer l'analyse"}
              </Button>
              {job.stage !== 'abandoned' && <Button variant="ghost" icon={<ThumbsDown className="size-4" />} onClick={() => setRejecting(true)}>Écarter</Button>}
            </>
          )}
          {job.stage === 'ready_to_apply' && !validated && <Button variant="primary" icon={<Check className="size-4" />} loading={approve.isPending} onClick={() => approve.mutate()}>Valider les documents</Button>}
          {job.stage === 'ready_to_apply' && validated && link && (
            <a href={link} target="_blank" rel="noreferrer noopener" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-slate-800">
              <ExternalLink className="size-4" /> Ouvrir l'annonce
            </a>
          )}
          {PRE_SUBMIT.includes(job.stage) && (
            <Button variant={job.stage === 'ready_to_apply' && validated ? 'success' : 'ghost'} icon={<Check className="size-4" />} onClick={() => setSubmitted(true)}>
              {job.stage === 'ready_to_apply' && validated ? "J'ai postulé" : "J'ai déjà postulé"}
            </Button>
          )}
          {PRE_SUBMIT.includes(job.stage) && (
            <IconButton label="Supprimer cette offre" className="ml-auto" onClick={() => window.confirm('Supprimer définitivement cette offre et ses documents ?') && remove.mutate()}>
              <Trash2 className="size-4" />
            </IconButton>
          )}
        </div>
      </Card>

      {dups.length > 0 && (
        <Alert
          tone="warning"
          title="Doublon possible"
          action={<Button size="sm" variant="ghost" onClick={() => notDup.mutate()}>Ce n'est pas un doublon</Button>}
        >
          Cette offre ressemble à une offre déjà connue ({dups[0]!.reason}).{' '}
          <Link href={`/offres/${dups[0]!.id}`} className="font-medium underline">Voir l'autre offre</Link>{' '}
          <button type="button" className="font-medium underline" onClick={() => window.confirm("Fusionner l'autre offre dans celle-ci ?") && merge.mutate(dups[0]!.id)}>
            <Copy className="mr-0.5 inline size-3.5" />Fusionner
          </button>
        </Alert>
      )}
      {job.flags?.injection?.length > 0 && (
        <Alert tone="warning" title="Annonce à relire">
          Le texte de cette annonce contient un passage adressé à une IA (« {String(job.flags.injection[0].excerpt).slice(0, 140)} »). Il est traité comme une simple donnée et aucune action automatique n'est prise pour cette offre.
        </Alert>
      )}
      {job.flags?.contentChangedAt && <Alert tone="info">L'annonce a été modifiée le {formatDate(job.flags.contentChangedAt)} depuis sa première observation.</Alert>}

      <Tabs
        tabs={[
          { id: 'analysis', label: 'Analyse' },
          { id: 'documents', label: 'Documents', count: d.cvVersions.length + d.letters.length || undefined },
          { id: 'offer', label: 'Annonce' },
          { id: 'history', label: 'Historique' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'analysis' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            {analysis ? (
              <Card className="p-4 sm:p-5">
                <CardHeader
                  flush
                  title="Analyse ATS"
                  description={`Votre prompt, exécuté tel quel${analysis.parsed?.pdfAttached ? ', avec le PDF du CV joint' : ''} · ${formatDate(analysis.createdAt, true)}`}
                  action={
                    d.analyses.length > 1 ? (
                      <select className="rounded-lg border-0 bg-slate-100 py-1 pr-7 pl-2 text-[12px] font-medium text-slate-700" value={analysisIndex} onChange={(e) => setAnalysisIndex(Number(e.target.value))} aria-label="Version de l'analyse">
                        {d.analyses.map((a, i) => (
                          <option key={a.id} value={i}>
                            {a.score != null ? `${a.score}/20` : '—'} · {d.cvVersions.some((c) => c.id === a.cvVersionId) ? 'CV personnalisé' : 'CV master'} · {formatDate(a.createdAt)}
                          </option>
                        ))}
                      </select>
                    ) : undefined
                  }
                />
                {analysis.parsed?.scoreConflict && <div className="mt-3"><Alert tone="warning">La note n'a pas pu être lue avec certitude : fiez-vous au rapport ci-dessous.</Alert></div>}
                {analysis.parsed?.truncated && <div className="mt-3"><Alert tone="warning">Le rapport a été interrompu avant sa fin (longueur maximale atteinte).</Alert></div>}
                {analysis.parsed?.missingKeywords?.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[12.5px] font-medium text-slate-700">Mots-clés signalés absents du CV</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {analysis.parsed.missingKeywords.map((k: string) => <Badge key={k}>{k}</Badge>)}
                    </div>
                  </div>
                )}
                <div className="mt-4 border-t border-slate-100 pt-1">
                  <Report text={analysis.rawOutput} />
                </div>
              </Card>
            ) : (
              <Card className="p-5 text-[13px] text-slate-600">{working ? "L'analyse ATS est en cours : le rapport apparaîtra ici." : "Cette offre n'a pas encore été analysée avec votre prompt ATS."}</Card>
            )}
          </div>
          <div className="space-y-4">
            {(qual.summary || qual.strengths?.length || qual.gaps?.length || qual.blockers?.length) && (
              <Card className="p-4">
                <CardHeader flush title="Première lecture" description={job.qualificationMethod === 'llm' ? 'Notation rapide avant analyse complète' : 'Notation indicative, sans IA'} />
                {qual.summary && <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{qual.summary}</p>}
                <ul className="mt-2 space-y-1 text-[13px] text-slate-600">
                  {(qual.strengths ?? []).map((s, i) => <li key={`s${i}`} className="flex gap-1.5"><Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />{s}</li>)}
                  {(qual.blockers ?? []).map((s, i) => <li key={`b${i}`} className="flex gap-1.5"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-rose-600" />{s}</li>)}
                  {(qual.gaps ?? []).map((s, i) => <li key={`g${i}`} className="flex gap-1.5"><CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />{s}</li>)}
                  {(qual.rules?.warnings ?? []).map((s, i) => <li key={`w${i}`} className="flex gap-1.5"><CircleAlert className="mt-0.5 size-3.5 shrink-0 text-slate-400" />{s}</li>)}
                </ul>
              </Card>
            )}
            {PRE_DECISION.includes(job.stage) && analysis && (
              <Card className="p-4">
                <CardHeader flush title="Vos précisions" description="Elles sont prises en compte dans l'analyse et dans vos documents." />
                <div className="mt-3"><FeedbackForm stacked questions={questions} onChange={setFb} /></div>
                {(fb.skills.length > 0 || fb.note.trim()) && (
                  <Button className="mt-3" icon={<RefreshCw className="size-4" />} loading={review.isPending} onClick={() => review.mutate('reanalyze')}>Relancer l'analyse avec mes précisions</Button>
                )}
              </Card>
            )}
            <Card className="p-4">
              <CardHeader flush title="Notes personnelles" />
              <Textarea className="mt-2" rows={3} value={notes ?? job.notes} onChange={(e) => setNotes(e.target.value)} placeholder="Contact, impression, point à vérifier…" />
              {notes !== null && notes !== job.notes && <Button size="sm" className="mt-2" loading={update.isPending} onClick={() => update.mutate({ notes }, { onSuccess: () => setNotes(null) })}>Enregistrer</Button>}
            </Card>
          </div>
        </div>
      )}

      {tab === 'documents' && (
        <div className="space-y-4">
          {!cv && !letter ? (
            <Card className="p-5 text-[13px] text-slate-600">{working ? 'Les documents sont en préparation.' : 'Aucun document pour cette offre. Lancez « Préparer la candidature » pour obtenir un CV personnalisé et une lettre dans vos templates.'}</Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {cv && (
                <Card className="p-4 sm:p-5">
                  <CardHeader flush title={`CV personnalisé · version ${cv.version}`} description={cv.changeSummary} action={<Badge tone={cv.status === 'approved' ? 'success' : 'warning'}>{cv.status === 'approved' ? 'Validé' : 'À valider'}</Badge>} />
                  <div className="mt-3 grid gap-4 sm:grid-cols-[160px_1fr]">
                    {cv.checks?.render?.previewFileId ? (
                      <a href={fileUrl(cv.pdfFileId)} target="_blank" rel="noreferrer"><img src={fileUrl(cv.checks.render.previewFileId)} alt="Aperçu du CV" className="w-full rounded-lg bg-white shadow-card ring-1 ring-slate-200" /></a>
                    ) : <div className="flex aspect-[210/297] items-center justify-center rounded-lg bg-slate-50 text-[12px] text-slate-400 ring-1 ring-slate-200">Aperçu indisponible</div>}
                    <div className="min-w-0 space-y-3">
                      <DocLinks pdf={cv.pdfFileId} docx={cv.docxFileId} />
                      {cv.checks?.ats?.after != null && cv.checks?.ats?.before != null && (
                        <p className="text-[13px] text-slate-700">Note ATS : <span className="font-semibold tabular-nums">{cv.checks.ats.before}</span> → <span className={cx('font-semibold tabular-nums', cv.checks.ats.after > cv.checks.ats.before ? 'text-emerald-600' : '')}>{cv.checks.ats.after}/20</span> avec ce CV</p>
                      )}
                      <RenderChecks render={cv.checks?.render} />
                      {cv.checks?.keywordsSkipped?.length > 0 && (
                        <details className="rounded-lg bg-slate-50 p-2.5 text-[12.5px] text-slate-700">
                          <summary className="cursor-pointer font-medium">{cv.checks.keywordsSkipped.length} mot(s)-clé(s) non intégré(s), faute d'expérience qui les justifie</summary>
                          <ul className="mt-1.5 space-y-0.5">{cv.checks.keywordsSkipped.map((k: any, i: number) => <li key={i}><span className="font-medium">{k.keyword}</span> — {k.reason}</li>)}</ul>
                        </details>
                      )}
                      {cv.checks?.revertedForLayout?.length > 0 && <p className="text-[12.5px] text-slate-500">{cv.checks.revertedForLayout.length} reformulation(s) annulée(s) pour que le CV tienne sur la pagination de votre template (aucune information supprimée).</p>}
                    </div>
                  </div>
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <p className="mb-2 text-[13px] font-medium text-slate-800">Modifications par rapport au CV master</p>
                    <CvChanges cvId={cv.id} />
                  </div>
                  {d.cvVersions.length > 1 && <p className="mt-3 text-[12px] text-slate-500">{d.cvVersions.length - 1} version(s) précédente(s) conservée(s) : {d.cvVersions.slice(1).map((v) => (v.pdfFileId ? <a key={v.id} className="mr-2 underline" href={fileUrl(v.pdfFileId)} target="_blank" rel="noreferrer">v{v.version}</a> : <span key={v.id} className="mr-2">v{v.version}</span>))}</p>}
                </Card>
              )}
              {letter && (
                <Card className="p-4 sm:p-5">
                  <CardHeader flush title="Lettre de motivation" description={`Rédigée dans votre modèle · ${letter.checks?.words ?? '—'} mots`} action={<Badge tone={letter.status === 'approved' ? 'success' : 'warning'}>{letter.status === 'approved' ? 'Validée' : 'À valider'}</Badge>} />
                  <div className="mt-3 grid gap-4 sm:grid-cols-[160px_1fr]">
                    {letter.checks?.render?.previewFileId ? (
                      <a href={fileUrl(letter.pdfFileId)} target="_blank" rel="noreferrer"><img src={fileUrl(letter.checks.render.previewFileId)} alt="Aperçu de la lettre" className="w-full rounded-lg bg-white shadow-card ring-1 ring-slate-200" /></a>
                    ) : <div className="flex aspect-[210/297] items-center justify-center rounded-lg bg-slate-50 text-[12px] text-slate-400 ring-1 ring-slate-200">Aperçu indisponible</div>}
                    <div className="min-w-0 space-y-3">
                      <DocLinks pdf={letter.pdfFileId} docx={letter.docxFileId} />
                      <RenderChecks render={letter.checks?.render} />
                      {letter.checks?.truthfulness?.ok === false && (
                        <Alert tone="warning" title="Affirmations à vérifier">
                          <ul className="list-disc pl-4">{letter.checks.truthfulness.issues.map((i: string, n: number) => <li key={n}>{i}</li>)}</ul>
                        </Alert>
                      )}
                      {letter.checks?.notes && <p className="rounded-lg bg-sky-50 p-2.5 text-[12.5px] text-sky-900">{letter.checks.notes}</p>}
                    </div>
                  </div>
                  <details className="mt-4 border-t border-slate-100 pt-3">
                    <summary className="cursor-pointer text-[13px] font-medium text-slate-800">Lire le texte</summary>
                    <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap text-slate-700">{letter.text}</p>
                  </details>
                </Card>
              )}
            </div>
          )}
          {d.application?.submittedAt && (
            <Card className="p-4 sm:p-5">
              <CardHeader flush title="Envoi" description="Les documents ci-dessus sont ceux de cette candidature : ils sont conservés tels quels." action={<Badge tone="success">{d.application.confirmedAt ? 'Confirmation reçue' : 'Envoyée'}</Badge>} />
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
                <div className="flex justify-between gap-3 sm:block"><dt className="inline text-slate-500">Envoyée le </dt><dd className="inline font-medium text-slate-800">{formatDate(d.application.submittedAt)}{d.application.channel ? ` · ${d.application.channel}` : ''}</dd></div>
                {d.application.followUpDueAt && <div className="flex justify-between gap-3 sm:block"><dt className="inline text-slate-500">Relance à envisager à partir du </dt><dd className="inline font-medium text-slate-800">{formatDate(d.application.followUpDueAt)}</dd></div>}
              </dl>
              {d.application.confirmation?.text && <p className="mt-3 rounded-lg bg-emerald-50 p-2.5 text-[12.5px] text-emerald-900">Accusé de réception : « {d.application.confirmation.text} »</p>}
            </Card>
          )}
          {pack.data && (cv || letter) && !d.application?.submittedAt && (
            <Card className="p-4 sm:p-5">
              <CardHeader flush title="Contrôle avant candidature" description="Vérifié automatiquement avant toute validation." action={<Badge tone={pack.data.qa.ok ? 'success' : 'danger'}>{pack.data.qa.ok ? 'Rien de bloquant' : 'À corriger'}</Badge>} />
              <ul className="mt-3 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
                {pack.data.qa.checks.map((c) => (
                  <li key={c.id} className={cx('flex gap-1.5', c.ok ? 'text-slate-600' : c.severity === 'error' ? 'text-rose-700' : 'text-amber-700')}>
                    {c.ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
                    {c.message}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {tab === 'offer' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Card className="p-4 sm:p-5">
            <CardHeader flush title="Texte de l'annonce" description={job.language ? `Langue détectée : ${job.language.toUpperCase()}` : undefined} />
            {job.descriptionText ? <p className="mt-3 text-[13px] leading-relaxed whitespace-pre-wrap text-slate-700">{job.descriptionText}</p> : <p className="mt-3 text-[13px] text-slate-500">Le texte de cette annonce n'a pas été enregistré.</p>}
          </Card>
          <Card className="h-fit p-4">
            <CardHeader flush title="Sources" description="Où cette offre a été vue. Une seule fiche, quel que soit le nombre de diffusions." />
            <ul className="mt-3 space-y-2 text-[13px]">
              {d.sightings.map((s) => (
                <li key={s.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800">{s.sourceName ?? 'Source supprimée'}</p>
                    <p className="text-[12px] text-slate-500">Depuis le {formatDate(s.firstSeenAt)}{s.goneAt ? ` · retirée le ${formatDate(s.goneAt)}` : ` · revue ${relativeTime(s.lastSeenAt)}`}</p>
                  </div>
                  {s.url && <a href={s.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-slate-400 hover:text-slate-700" aria-label="Ouvrir cette source"><ExternalLink className="size-4" /></a>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tab === 'history' && (
        <Card className="p-4 sm:p-5">
          <ol className="relative space-y-4 border-l border-slate-200 pl-5">
            {[...d.history].reverse().map((h) => (
              <li key={h.id} className="relative">
                <span className="absolute top-1.5 -left-[25px] size-2 rounded-full bg-slate-300 ring-4 ring-white" />
                <p className="text-[13px] font-medium text-slate-900">{STAGE_LABELS[h.toStage as Stage] ?? h.toStage}</p>
                <p className="text-[12px] text-slate-500">{formatDate(h.at, true)} · {ACTORS[h.actor] ?? h.actor}{h.reason ? ` · ${h.reason}` : ''}</p>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Écarter cette offre"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)}>Annuler</Button>
            <Button variant="primary" loading={review.isPending} onClick={() => review.mutate('reject')}>Écarter</Button>
          </>
        }
      >
        <Field label="Pourquoi ? (facultatif)" hint="Votre raison affine les prochaines sélections.">
          <Textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. « trop de déplacements », « secteur qui ne m'intéresse pas »" />
        </Field>
      </Modal>
      <SubmittedModal jobId={id} open={submitted} onClose={() => setSubmitted(false)} onDone={refresh} />
    </div>
  );
}

/** Modifications d'une version de CV, lues dans sa traçabilité. */
function CvChanges({ cvId }: { cvId: string }) {
  const q = useQuery({ queryKey: ['cv', cvId], queryFn: () => get<{ cv: { provenance: { changes?: any[]; rejected?: any[] } | null } }>(`/profile/cv/${cvId}`) });
  if (q.isLoading) return <p className="text-[13px] text-slate-400">Chargement…</p>;
  const p = q.data?.cv.provenance ?? {};
  return <ChangeList changes={p.changes ?? []} rejected={p.rejected ?? []} />;
}
