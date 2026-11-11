import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Download, FileText, History, Pencil, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CvData } from '../../../../src/shared/cv';
import { CvEditor } from '../../components/CvEditor';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Loading, Modal, Textarea, useToast } from '../../components/ui';
import { del, get, post, put, upload } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { errorText } from '../../lib/hooks';
import { DocumentsPanel } from './DocumentsPanel';

interface VersionRow {
  id: string;
  kind: string;
  label: string;
  language: string;
  version: number;
  status: 'draft' | 'approved' | 'archived';
  isCurrent: boolean;
  source: string;
  changeSummary: string;
  createdAt: string;
  approvedAt: string | null;
  sourceFileId: string | null;
  parentId: string | null;
}

const SOURCE_LABELS: Record<string, string> = { upload: 'Import', manual: 'Modification manuelle', linkedin: 'LinkedIn', feedback: 'Correction', tailor: 'Personnalisation', translation: 'Traduction' };

export function CvTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [diffFor, setDiffFor] = useState<string | null>(null);

  const versions = useQuery({ queryKey: ['cv-versions'], queryFn: () => get<{ versions: VersionRow[] }>('/profile/cv?kind=master') });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cv-versions'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
    void qc.invalidateQueries({ queryKey: ['facts'] });
  };

  const onImported = (res: { cv: { id: string }; warnings: string[] }) => {
    refresh();
    setEditing(res.cv.id);
    for (const w of res.warnings) toast(w, 'warning');
  };
  const importFile = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('file', file);
      return upload<{ cv: { id: string }; warnings: string[] }>('/profile/cv/import', form);
    },
    onSuccess: onImported,
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const importText = useMutation({
    mutationFn: () => post<{ cv: { id: string }; warnings: string[] }>('/profile/cv/import-text', { text: pasted }),
    onSuccess: (res) => {
      setPasteOpen(false);
      setPasted('');
      onImported(res);
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const fork = useMutation({
    mutationFn: (id: string) => post<{ cv: { id: string } }>(`/profile/cv/${id}/fork`),
    onSuccess: (res) => {
      refresh();
      setEditing(res.cv.id);
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });

  if (versions.isLoading) return <Loading />;
  const all = versions.data?.versions ?? [];
  const masters = all.filter((v) => v.isCurrent);
  const drafts = all.filter((v) => v.status === 'draft');
  const history = all.filter((v) => v.status === 'approved' && !v.isCurrent);

  return (
    <div className="space-y-5">
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile.mutate(f);
          e.target.value = '';
        }}
      />

      <Card>
        <CardHeader
          icon={<FileText className="size-4" />}
          title="CV master"
          description="La seule source de vérité de votre parcours. Il n'est jamais modifié sans votre validation, et chaque version est conservée."
          action={
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setPasteOpen(true)}>
                Coller le texte
              </Button>
              <Button size="sm" variant="primary" icon={<Upload className="size-4" />} loading={importFile.isPending} onClick={() => fileRef.current?.click()}>
                {masters.length ? 'Importer une nouvelle version' : 'Importer mon CV'}
              </Button>
            </div>
          }
        />
        <div className="px-5 pb-5">
          {importFile.isPending && <Alert tone="info">Lecture et structuration du document en cours…</Alert>}
          {masters.length === 0 && drafts.length === 0 && !importFile.isPending && (
            <EmptyState icon={<Upload className="size-5" />} title="Aucun CV master" description="Importez votre CV (PDF, Word ou texte). Il sera structuré, puis vous le relirez avant de le valider." />
          )}
          <ul className="divide-y divide-slate-100">
            {masters.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                    <CircleCheck className="size-4 text-emerald-600" /> CV master {m.language.toUpperCase()} · version {m.version}
                  </p>
                  <p className="mt-0.5 text-[13px] text-slate-500">
                    {m.label} · validé le {formatDate(m.approvedAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  {m.sourceFileId && (
                    <a href={`/api/files/${m.sourceFileId}`} target="_blank" rel="noreferrer">
                      <Button size="sm" icon={<Download className="size-4" />}>
                        Fichier d'origine
                      </Button>
                    </a>
                  )}
                  <Button size="sm" icon={<Pencil className="size-4" />} loading={fork.isPending} onClick={() => fork.mutate(m.id)}>
                    Modifier
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {drafts.length > 0 && (
        <Card>
          <CardHeader title="Brouillons à relire" description="Un brouillon ne remplace le CV master qu'une fois validé par vous." />
          <ul className="divide-y divide-slate-100 px-5 pb-3">
            {drafts.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">
                    {d.label} <Badge tone="warning">Brouillon</Badge> <Badge>{SOURCE_LABELS[d.source] ?? d.source}</Badge>
                  </p>
                  <p className="mt-0.5 text-[13px] text-slate-500">
                    {d.language.toUpperCase()} · créé le {formatDate(d.createdAt, true)}
                    {d.changeSummary && ` · ${d.changeSummary}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  {d.parentId && (
                    <Button size="sm" onClick={() => setDiffFor(d.id)}>
                      Voir les changements
                    </Button>
                  )}
                  <Button size="sm" variant="primary" onClick={() => setEditing(d.id)}>
                    Relire et valider
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <DocumentsPanel />

      {history.length > 0 && (
        <Card>
          <CardHeader icon={<History className="size-4" />} title="Historique du CV master" description="Les anciennes versions restent consultables et peuvent être restaurées." />
          <ul className="divide-y divide-slate-100 px-5 pb-3">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-[13px]">
                <span className="text-slate-700">
                  Version {h.version} ({h.language.toUpperCase()}) · {SOURCE_LABELS[h.source] ?? h.source} · validée le {formatDate(h.approvedAt)}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setDiffFor(h.id)}>
                    Comparer
                  </Button>
                  <Button size="sm" onClick={() => fork.mutate(h.id)}>
                    Restaurer
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        title="Coller le texte de votre CV"
        footer={
          <Button variant="primary" disabled={pasted.trim().length < 80} loading={importText.isPending} onClick={() => importText.mutate()}>
            Analyser
          </Button>
        }
      >
        <Textarea rows={14} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Collez ici le contenu complet de votre CV…" />
      </Modal>

      {editing && <DraftEditor id={editing} onClose={() => setEditing(null)} onChanged={refresh} />}
      {diffFor && <DiffModal id={diffFor} masterId={masters[0]?.id} onClose={() => setDiffFor(null)} />}
    </div>
  );
}

function DraftEditor({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['cv', id], queryFn: () => get<{ cv: { id: string; data: CvData; status: string; label: string; language: string; checks: any; changeSummary: string } }>(`/profile/cv/${id}`) });
  const [draft, setDraft] = useState<CvData | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (q.data) {
      setDraft(q.data.cv.data);
      setDirty(false);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => put(`/profile/cv/${id}`, { data: draft }),
    onSuccess: () => {
      setDirty(false);
      onChanged();
      toast('Brouillon enregistré', 'success');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const approve = useMutation({
    mutationFn: async () => {
      if (dirty) await put(`/profile/cv/${id}`, { data: draft });
      return post(`/profile/cv/${id}/approve`);
    },
    onSuccess: () => {
      onChanged();
      toast('CV master validé', 'success');
      onClose();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const remove = useMutation({
    mutationFn: () => del(`/profile/cv/${id}`),
    onSuccess: () => {
      onChanged();
      onClose();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });

  const checks = q.data?.cv.checks ?? {};
  const grounding = (checks.grounding ?? []) as { path: string; value: string; coverage: number }[];
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Relire le CV avant validation"
      footer={
        <>
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            Supprimer le brouillon
          </Button>
          <div className="flex-1" />
          <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            Enregistrer
          </Button>
          <Button variant="success" loading={approve.isPending} onClick={() => approve.mutate()}>
            Valider comme CV master
          </Button>
        </>
      }
    >
      {!draft ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {checks.method === 'rules' && <Alert tone="warning">Structure proposée sans IA (aucune clé d'API configurée) : vérifiez que chaque expérience est correctement découpée.</Alert>}
          {grounding.length > 0 && (
            <Alert tone="warning" title={`${grounding.length} élément(s) à vérifier`}>
              Leur texte ne correspond pas exactement au document importé. Ils sont signalés en orange ci-dessous.
            </Alert>
          )}
          {q.data?.cv.changeSummary && <Alert tone="info" title="Modifications proposées">{q.data.cv.changeSummary}</Alert>}
          <CvEditor
            value={draft}
            warnings={grounding}
            onChange={(v) => {
              setDraft(v);
              setDirty(true);
            }}
          />
        </div>
      )}
    </Modal>
  );
}

function DiffModal({ id, masterId, onClose }: { id: string; masterId?: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['cv-diff', id, masterId], queryFn: () => get<{ changes: { kind: string; section: string; where: string; before?: string; after?: string }[] }>(`/profile/cv/${id}/diff${masterId && masterId !== id ? `?against=${masterId}` : ''}`) });
  return (
    <Modal open wide onClose={onClose} title="Différences entre les versions">
      {q.isLoading ? (
        <Loading />
      ) : q.data?.changes.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">Aucune différence de contenu.</p>
      ) : (
        <ul className="space-y-3">
          {q.data?.changes.map((c, i) => (
            <li key={i} className="rounded-xl bg-slate-50 p-3 text-[13px]">
              <p className="mb-1 font-medium text-slate-700">
                <Badge tone={c.kind === 'added' ? 'success' : c.kind === 'removed' ? 'danger' : 'info'}>{c.kind === 'added' ? 'Ajout' : c.kind === 'removed' ? 'Retrait' : 'Modification'}</Badge> {c.section} · {c.where}
              </p>
              {c.before && <p className="text-rose-700 line-through decoration-rose-300">{c.before}</p>}
              {c.after && <p className="text-emerald-800">{c.after}</p>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
