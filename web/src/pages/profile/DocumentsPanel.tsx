// « Mes documents » : templates de CV et de lettre (versions, aperçu, import) et
// documents générés pour chaque candidature.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileCheck, LayoutTemplate, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'wouter';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Modal, useToast } from '../../components/ui';
import { get, post, upload } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { errorText } from '../../lib/hooks';

interface TemplateRow {
  id: string;
  kind: 'cv' | 'letter';
  name: string;
  language: string;
  version: number;
  isActive: boolean;
  origin: 'upload' | 'built' | 'evolved';
  createdAt: string;
  notes: string[];
  sourceFileId: string;
  docxFileId: string;
  pdfFileId: string | null;
  previewFileId: string | null;
  fonts: string[];
  sections?: { label: string; brief: string }[];
  mapped?: number;
  unmatched?: number;
}

interface Generated {
  cvs: { id: string; jobId: string | null; label: string; status: string; createdAt: string; pdfFileId: string | null; docxFileId: string | null; render: { ok: boolean | null; pages: number | null } | null; job: { id: string; title: string; companyName: string } | null }[];
  letters: { id: string; jobId: string | null; status: string; createdAt: string; pdfFileId: string | null; docxFileId: string | null; kind: string; job: { id: string; title: string; companyName: string } | null }[];
}

const ORIGIN: Record<string, string> = { upload: 'Votre fichier', built: 'Constitué à partir de votre CV', evolved: 'Mis à jour avec le CV master' };

function FileLinks({ pdf, docx }: { pdf: string | null; docx: string | null }) {
  return (
    <span className="flex gap-1.5">
      {pdf && (
        <a href={`/api/files/${pdf}`} target="_blank" rel="noreferrer">
          <Button size="sm" icon={<Download className="size-3.5" />}>
            PDF
          </Button>
        </a>
      )}
      {docx && (
        <a href={`/api/files/${docx}?download=1`}>
          <Button size="sm" icon={<Download className="size-3.5" />}>
            Word
          </Button>
        </a>
      )}
    </span>
  );
}

function TemplateCard({ kind, title, description, rows, onImport, importing, onActivate }: { kind: 'cv' | 'letter'; title: string; description: string; rows: TemplateRow[]; onImport: () => void; importing: boolean; onActivate: (id: string) => void }) {
  const [preview, setPreview] = useState<TemplateRow | null>(null);
  const active = rows.filter((r) => r.isActive);
  const older = rows.filter((r) => !r.isActive);
  return (
    <Card>
      <CardHeader
        icon={<LayoutTemplate className="size-4" />}
        title={title}
        description={description}
        action={
          <Button size="sm" variant={active.length ? 'secondary' : 'primary'} icon={<Upload className="size-4" />} loading={importing} onClick={onImport}>
            {active.length ? 'Importer une nouvelle version' : 'Importer'}
          </Button>
        }
      />
      <div className="px-5 pb-5">
        {active.length === 0 && <EmptyState title="Aucun template" description={kind === 'cv' ? 'Il est créé automatiquement à la validation de votre CV master. Importez votre CV au format Word pour reprendre exactement votre mise en page.' : 'Importez votre modèle de lettre (Word ou RTF) : les zones à remplir doivent être entre crochets, par exemple [Introduction].'} />}
        <ul className="space-y-4">
          {active.map((t) => (
            <li key={t.id} className="flex flex-wrap gap-4">
              {t.previewFileId ? (
                <button type="button" onClick={() => setPreview(t)} className="shrink-0 overflow-hidden rounded-lg shadow-card ring-1 ring-slate-200 transition hover:ring-indigo-400" aria-label="Agrandir l'aperçu">
                  <img src={`/api/files/${t.previewFileId}`} alt={`Aperçu du template ${t.name}`} className="h-44 w-auto bg-white" />
                </button>
              ) : (
                <div className="flex h-44 w-32 shrink-0 items-center justify-center rounded-lg bg-slate-50 px-3 text-center text-xs text-slate-400 ring-1 ring-slate-200">Aperçu produit par le worker de documents</div>
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-medium text-slate-900">
                  {t.name} <Badge tone="brand">Version {t.version}</Badge> {t.kind === 'cv' && <Badge>{t.language.toUpperCase()}</Badge>}
                </p>
                <p className="text-[13px] text-slate-500">
                  {ORIGIN[t.origin]} · {formatDate(t.createdAt)} · polices : {t.fonts.join(', ') || '—'}
                </p>
                {t.kind === 'cv' && t.origin !== 'upload' && (
                  <Alert tone="warning">
                    Ce document a été constitué à partir de votre CV, faute de fichier Word. Importez votre CV au format Word (.docx) : il deviendra le template et vos documents reprendront exactement sa mise en page.
                  </Alert>
                )}
                {t.kind === 'cv' && t.unmatched ? <p className="text-[13px] text-amber-700">{t.unmatched} élément(s) du CV master non retrouvé(s) dans ce document.</p> : null}
                {t.sections && (
                  <p className="text-[13px] text-slate-600">
                    Rubriques du modèle : {t.sections.map((s) => s.label).join(' · ')}
                  </p>
                )}
                {t.notes.map((n, i) => (
                  <p key={i} className="text-[13px] leading-snug text-slate-500">
                    {n}
                  </p>
                ))}
                <div className="flex flex-wrap gap-1.5">
                  <a href={`/api/files/${t.sourceFileId}?download=1`}>
                    <Button size="sm" icon={<Download className="size-3.5" />}>
                      Fichier d'origine
                    </Button>
                  </a>
                  <FileLinks pdf={t.pdfFileId} docx={t.docxFileId !== t.sourceFileId ? t.docxFileId : null} />
                </div>
              </div>
            </li>
          ))}
        </ul>
        {older.length > 0 && (
          <details className="mt-4 text-[13px]">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-800">Versions précédentes ({older.length})</summary>
            <ul className="mt-2 divide-y divide-slate-100">
              {older.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-slate-600">
                    Version {t.version} · {t.name} · {ORIGIN[t.origin]} · {formatDate(t.createdAt)}
                  </span>
                  <span className="flex gap-1.5">
                    <a href={`/api/files/${t.sourceFileId}?download=1`}>
                      <Button size="sm">Télécharger</Button>
                    </a>
                    <Button size="sm" onClick={() => onActivate(t.id)}>
                      Restaurer
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} wide title={preview?.name ?? ''}>
        {preview?.pdfFileId ? <iframe title="Aperçu" src={`/api/files/${preview.pdfFileId}`} className="h-[70dvh] w-full rounded-lg ring-1 ring-slate-200" /> : preview?.previewFileId ? <img src={`/api/files/${preview.previewFileId}`} alt="" className="mx-auto" /> : null}
      </Modal>
    </Card>
  );
}

export function DocumentsPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const cvRef = useRef<HTMLInputElement>(null);
  const letterRef = useRef<HTMLInputElement>(null);
  const q = useQuery({ queryKey: ['templates'], queryFn: () => get<{ capabilities: { office: boolean; poppler: boolean }; templates: TemplateRow[] }>('/documents/templates') });
  const generated = useQuery({ queryKey: ['generated-documents'], queryFn: () => get<Generated>('/documents/generated') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['templates'] });
  const importTpl = useMutation({
    mutationFn: (v: { kind: 'cv' | 'letter'; file: File }) => {
      const form = new FormData();
      form.set('file', v.file);
      return upload(`/documents/templates/${v.kind}`, form);
    },
    onSuccess: () => {
      refresh();
      toast('Template importé et analysé', 'success');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const activate = useMutation({ mutationFn: (id: string) => post(`/documents/templates/${id}/activate`), onSuccess: refresh, onError: (e) => toast(errorText(e), 'danger') });

  const rows = q.data?.templates ?? [];
  const pick = (kind: 'cv' | 'letter') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) importTpl.mutate({ kind, file: f });
    e.target.value = '';
  };
  const docs = generated.data;
  return (
    <>
      <input ref={cvRef} type="file" accept=".docx,.doc,.rtf,.odt" className="hidden" onChange={pick('cv')} />
      <input ref={letterRef} type="file" accept=".docx,.doc,.rtf,.odt" className="hidden" onChange={pick('letter')} />
      {q.data && !q.data.capabilities.office && (
        <Alert tone="info" title="Rendu PDF différé">
          Cette instance ne dispose pas du moteur de rendu : les fichiers Word sont produits immédiatement, les PDF et leur contrôle visuel le sont par le worker de documents.
        </Alert>
      )}
      <TemplateCard
        kind="cv"
        title="Template de CV"
        description="Le modèle graphique de tous vos CV. Chaque CV personnalisé est une copie de ce document : mise en page, polices, marges et espacements restent les siens."
        rows={rows.filter((r) => r.kind === 'cv')}
        importing={importTpl.isPending && importTpl.variables?.kind === 'cv'}
        onImport={() => cvRef.current?.click()}
        onActivate={(id) => activate.mutate(id)}
      />
      <TemplateCard
        kind="letter"
        title="Template de lettre de motivation"
        description="Le modèle graphique de toutes vos lettres. Seul le contenu des zones change ; la présentation reste celle du modèle."
        rows={rows.filter((r) => r.kind === 'letter')}
        importing={importTpl.isPending && importTpl.variables?.kind === 'letter'}
        onImport={() => letterRef.current?.click()}
        onActivate={(id) => activate.mutate(id)}
      />
      <Card>
        <CardHeader icon={<FileCheck className="size-4" />} title="Documents générés" description="Chaque CV et chaque lettre reste associé à son offre : vous retrouvez à tout moment les documents exacts d'une candidature." />
        {!docs || (docs.cvs.length === 0 && docs.letters.length === 0) ? (
          <EmptyState title="Aucun document généré pour le moment" description="Ils apparaîtront ici dès qu'une candidature sera préparée." />
        ) : (
          <ul className="divide-y divide-slate-100 px-5 pb-3 text-[13px]">
            {docs.cvs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="font-medium text-slate-800">CV</span>{' '}
                  {d.job ? (
                    <Link href={`/offres/${d.job.id}`} className="text-indigo-600 hover:underline">
                      {d.job.title} — {d.job.companyName}
                    </Link>
                  ) : (
                    d.label
                  )}{' '}
                  <Badge tone={d.status === 'approved' ? 'success' : 'warning'}>{d.status === 'approved' ? 'Validé' : 'À valider'}</Badge>{' '}
                  {d.render?.ok === false && <Badge tone="danger">Rendu à corriger</Badge>}
                  <span className="ml-2 text-xs text-slate-400">{formatDate(d.createdAt)}</span>
                </span>
                <FileLinks pdf={d.pdfFileId} docx={d.docxFileId} />
              </li>
            ))}
            {docs.letters.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="font-medium text-slate-800">Lettre</span>{' '}
                  {d.job ? (
                    <Link href={`/offres/${d.job.id}`} className="text-indigo-600 hover:underline">
                      {d.job.title} — {d.job.companyName}
                    </Link>
                  ) : (
                    'Lettre de référence'
                  )}{' '}
                  <Badge tone={d.status === 'approved' ? 'success' : 'warning'}>{d.status === 'approved' ? 'Validée' : 'À valider'}</Badge>
                  <span className="ml-2 text-xs text-slate-400">{formatDate(d.createdAt)}</span>
                </span>
                <FileLinks pdf={d.pdfFileId} docx={d.docxFileId} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
