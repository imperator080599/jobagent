// Offres : liste triée par priorité, filtres par étape, ajout manuel (adresse ou texte collé).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, CalendarClock, Copy, Layers, Plus, Search, Sparkles, Star } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea, useToast } from '../components/ui';
import { ApiError, get, patch, post } from '../lib/api';
import { cx, formatDate, relativeTime } from '../lib/format';
import { errorText } from '../lib/hooks';
import { JobDetail } from './jobs/JobDetail';
import { AtsPill, StageBadge, contractLabel, jobPlace, type JobListItem } from './jobs/shared';

type View = 'decide' | 'analysis' | 'preparation' | 'discarded' | 'all';
const VIEWS: Record<View, { label: string; stages: string; empty: string }> = {
  decide: { label: 'À décider', stages: 'awaiting_feedback', empty: "Aucune offre n'attend votre avis." },
  analysis: { label: 'En analyse', stages: 'new,to_analyze,analyzed', empty: "Aucune offre en cours d'analyse." },
  preparation: { label: 'En préparation', stages: 'cv_in_progress,letter_in_progress,ready_to_apply,applying', empty: 'Aucune candidature en préparation.' },
  discarded: { label: 'Écartées', stages: 'filtered,abandoned,expired', empty: 'Aucune offre écartée.' },
  all: { label: 'Toutes', stages: '', empty: 'Aucune offre pour le moment.' },
};
const count = (counts: Record<string, number> | undefined, stages: string) => (counts ? (stages ? stages.split(',') : Object.keys(counts)).reduce((n, s) => n + (counts[s] ?? 0), 0) : 0);

function AddJobModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (id: string) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [fields, setFields] = useState<{ title: string; company: string; location: string } | null>(null);
  const [duplicate, setDuplicate] = useState<any>(null);
  const [needsText, setNeedsText] = useState('');
  const reset = () => {
    setUrl('');
    setText('');
    setFields(null);
    setDuplicate(null);
    setNeedsText('');
  };
  const add = useMutation({
    mutationFn: () => post('/jobs', { url: url.trim() || undefined, text: text.trim() || undefined, ...(fields ? { title: fields.title, company: fields.company, location: fields.location || undefined } : {}) }),
    onSuccess: (d) => {
      if (d.outcome === 'duplicate') {
        setDuplicate(d);
        return;
      }
      toast("Offre ajoutée. L'analyse démarre.", 'success');
      reset();
      onAdded(d.job.id);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'page_unreadable') setNeedsText(e.message);
      else if (e instanceof ApiError && e.code === 'fields_missing') setFields({ title: (e.details as any)?.guess?.title ?? '', company: (e.details as any)?.guess?.company ?? '', location: (e.details as any)?.guess?.location ?? '' });
      else toast(errorText(e), 'danger');
    },
  });
  const close = () => {
    reset();
    onClose();
  };
  const canSubmit = (url.trim().length > 8 || text.trim().length >= 80) && (!fields || (fields.title.trim().length > 1 && fields.company.trim().length > 0));
  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title="Ajouter une offre"
      footer={
        duplicate ? (
          <>
            <Button variant="ghost" onClick={close}>Fermer</Button>
            <Button variant="primary" onClick={() => { const id = duplicate.job.id; reset(); onAdded(id); }}>Ouvrir l'offre existante</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>Annuler</Button>
            <Button variant="primary" loading={add.isPending} disabled={!canSubmit} onClick={() => add.mutate()}>Ajouter et analyser</Button>
          </>
        )
      }
    >
      {duplicate ? (
        <Alert tone={duplicate.verdict.alreadyApplied ? 'warning' : 'info'} title={duplicate.verdict.alreadyApplied ? 'Vous avez déjà postulé à cette offre' : 'Cette offre est déjà connue'}>
          <p>
            <strong>{duplicate.job.companyName}</strong> — {duplicate.job.title}
          </p>
          <p className="mt-1">{duplicate.verdict.summary} Aucune fiche n'a été créée en double.</p>
        </Alert>
      ) : (
        <div className="space-y-4">
          <Field label="Adresse de l'offre" hint="La page est lue comme le ferait un lecteur ordinaire. Si le site refuse l'accès automatisé, collez simplement le texte ci-dessous.">
            <Input type="url" inputMode="url" placeholder="https://…" value={url} autoFocus onChange={(e) => setUrl(e.target.value)} />
          </Field>
          {needsText && <Alert tone="warning">{needsText}</Alert>}
          <Field label="Texte de l'offre" hint="Facultatif si l'adresse suffit. Indispensable pour LinkedIn, Indeed et les sites protégés.">
            <Textarea rows={needsText || text ? 9 : 4} placeholder="Collez ici l'annonce complète (intitulé, entreprise, missions, profil recherché)…" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          {fields && (
            <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200 ring-inset">
              <p className="text-[13px] font-medium text-amber-900">Quelques informations n'ont pas pu être lues : complétez-les.</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <Field label="Intitulé du poste"><Input value={fields.title} onChange={(e) => setFields({ ...fields, title: e.target.value })} /></Field>
                <Field label="Entreprise"><Input value={fields.company} onChange={(e) => setFields({ ...fields, company: e.target.value })} /></Field>
                <Field label="Lieu"><Input value={fields.location} onChange={(e) => setFields({ ...fields, location: e.target.value })} /></Field>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function JobRow({ job, onStar }: { job: JobListItem; onStar: () => void }) {
  const place = jobPlace(job);
  const contract = contractLabel(job.contractType);
  const dup = job.flags?.possibleDuplicates?.length > 0;
  const deadlineSoon = job.deadlineAt && new Date(job.deadlineAt).getTime() - Date.now() < 7 * 86400_000;
  return (
    <li className="group relative flex items-center gap-3 px-3 py-3 transition-colors hover:bg-slate-50 sm:gap-4 sm:px-4">
      <AtsPill score={job.atsScore} decision={job.atsDecision} />
      <div className="min-w-0 flex-1">
        <Link href={`/offres/${job.id}`} className="block truncate text-sm font-semibold text-slate-900 after:absolute after:inset-0">
          {job.title}
        </Link>
        <p className="truncate text-[13px] text-slate-600">
          {job.companyName}
          {place && <span className="text-slate-400"> · {place}</span>}
          {contract && <span className="text-slate-400"> · {contract}</span>}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <StageBadge stage={job.stage} />
          {job.strategic && <Badge tone="info"><Sparkles className="size-3" /> Stratégique</Badge>}
          {job.sourcesCount > 1 && <Badge title="Offre vue sur plusieurs sources, regroupée en une seule fiche"><Layers className="size-3" /> {job.sourcesCount} sources</Badge>}
          {dup && <Badge tone="warning"><Copy className="size-3" /> Doublon possible</Badge>}
          {job.deadlineAt && <Badge tone={deadlineSoon ? 'warning' : 'neutral'}><CalendarClock className="size-3" /> {formatDate(job.deadlineAt)}</Badge>}
          {job.flags?.injection?.length > 0 && <Badge tone="warning">À relire</Badge>}
        </div>
      </div>
      <div className="hidden shrink-0 text-right sm:block">
        <p className="text-[12px] text-slate-500 tabular-nums">{job.priorityScore != null ? <>Priorité <span className="font-semibold text-slate-800">{Math.round(job.priorityScore)}</span></> : '—'}</p>
        <p className="text-[11.5px] text-slate-400">{relativeTime(job.postedAt ?? job.firstSeenAt)}</p>
      </div>
      <button type="button" onClick={onStar} aria-label={job.starred ? 'Retirer des favoris' : 'Ajouter aux favoris'} className={cx('relative z-10 rounded-lg p-1.5 transition-colors hover:bg-slate-200/60', job.starred ? 'text-amber-500' : 'text-slate-300 hover:text-slate-500')}>
        <Star className="size-[18px]" fill={job.starred ? 'currentColor' : 'none'} />
      </button>
    </li>
  );
}

export function JobsPage() {
  const params = useParams<{ id?: string }>();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const [view, setView] = useState<View>('decide');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('priority');
  const [adding, setAdding] = useState(false);
  const stages = VIEWS[view].stages;
  const list = useQuery({
    queryKey: ['jobs', view, q, sort],
    queryFn: () => get<{ items: JobListItem[]; total: number; counts: Record<string, number> }>(`/jobs?${new URLSearchParams({ ...(stages ? { stage: stages } : { all: '1' }), ...(q.trim() ? { q: q.trim() } : {}), sort, limit: '100' })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
    enabled: !params.id,
  });
  const star = useMutation({
    mutationFn: (j: JobListItem) => patch(`/jobs/${j.id}`, { starred: !j.starred }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (e) => toast(errorText(e), 'danger'),
  });

  if (params.id) return <JobDetail id={params.id} />;

  const counts = list.data?.counts;
  const items = list.data?.items ?? [];
  const nothingAtAll = counts && Object.keys(counts).length === 0;
  return (
    <>
      <PageHeader
        title="Offres"
        description="Chaque offre n'apparaît qu'une fois, même si elle est diffusée sur plusieurs sites. Les plus prioritaires sont en tête."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Ajouter une offre</Button>}
      />
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs tabs={(Object.keys(VIEWS) as View[]).map((id) => ({ id, label: VIEWS[id].label, count: id === 'all' ? undefined : count(counts, VIEWS[id].stages) }))} value={view} onChange={setView} />
        <div className="flex gap-2">
          <div className="relative flex-1 lg:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9" placeholder="Intitulé, entreprise, lieu…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher une offre" />
          </div>
          <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Trier" className="w-40">
            <option value="priority">Priorité</option>
            <option value="recent">Plus récentes</option>
            <option value="ats">Note ATS</option>
            <option value="deadline">Date limite</option>
            <option value="updated">Dernière activité</option>
          </Select>
        </div>
      </div>
      {list.isLoading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Briefcase className="size-5 text-slate-400" />}
            title={q ? 'Aucune offre ne correspond à cette recherche' : nothingAtAll ? 'Aucune offre pour le moment' : VIEWS[view].empty}
            description={nothingAtAll ? "Ajoutez une première offre par son adresse ou en collant son texte : elle sera notée, analysée avec votre prompt ATS, puis présentée dans « À valider »." : undefined}
            action={nothingAtAll ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Ajouter une offre</Button> : undefined}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {items.map((j) => (
              <JobRow key={j.id} job={j} onStar={() => star.mutate(j)} />
            ))}
          </ul>
          {list.data && list.data.total > items.length && <p className="border-t border-slate-100 px-4 py-2.5 text-center text-[12px] text-slate-500">{items.length} offres affichées sur {list.data.total}. Affinez la recherche pour voir les suivantes.</p>}
        </Card>
      )}
      <AddJobModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(id) => {
          setAdding(false);
          void qc.invalidateQueries({ queryKey: ['jobs'] });
          navigate(`/offres/${id}`);
        }}
      />
    </>
  );
}
