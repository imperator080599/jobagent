import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileCheck2, FileUp, ScanSearch, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, Modal, Textarea, useToast } from '../../components/ui';
import { get, post, upload } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { errorText } from '../../lib/hooks';

interface Version {
  id: string;
  version: number;
  note: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  length: number;
  sha256: string;
}

interface Difference {
  position: number;
  line: number;
  column: number;
  expected: string;
  actual: string;
  context: string;
}

interface Comparison {
  identical: boolean;
  lineEndingsOnly: boolean;
  differences: Difference[];
  version: { id: string; version: number; sha256: string; chars: number; storedShaValid: boolean };
  reference: { sha256: string; chars: number };
  fileSha256: string | null;
  notes: string[];
}

interface ImportResult {
  created: boolean;
  prompt: Version;
  identicalToFile: boolean;
  file: { name: string; sha256: string; bytes: number };
  storedSha256: string;
  notes: string[];
}

/** Rend visibles les caractères invisibles (espaces insécables, tabulations, fins de ligne) dans un écart. */
function visible(s: string): string {
  if (!s) return '∅';
  return s.replace(/\r/g, '␍').replace(/\n/g, '␊').replace(/\t/g, '⇥').replace(/\u00a0/g, '⍽').replace(/\u202f/g, '⍽').replace(/ /g, '·');
}

export function AtsPromptTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ats-prompt'], queryFn: () => get<{ active: (Version & { content: string }) | null; versions: Version[] }>('/profile/ats-prompt') });
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  useEffect(() => {
    if (q.data?.active) setContent(q.data.active.content);
  }, [q.data?.active?.id]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['ats-prompt'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const save = useMutation({
    mutationFn: () => post<{ created: boolean; prompt: Version }>('/profile/ats-prompt', { content, note }),
    onSuccess: (r) => {
      refresh();
      setNote('');
      toast(r.created ? `Version ${r.prompt.version} enregistrée et activée` : 'Aucun changement : cette version est déjà active', r.created ? 'success' : 'neutral');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const activate = useMutation({ mutationFn: (id: string) => post(`/profile/ats-prompt/${id}/activate`), onSuccess: refresh });
  const importInput = useRef<HTMLInputElement>(null);
  const compareInput = useRef<HTMLInputElement>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const importFile = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('file', file);
      return upload<ImportResult>('/profile/ats-prompt/import', form);
    },
    onSuccess: (r) => {
      refresh();
      setImported(r);
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const compare = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('file', file);
      if (viewing) form.set('versionId', viewing);
      return upload<Comparison>('/profile/ats-prompt/compare', form);
    },
    onSuccess: setComparison,
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const viewed = useQuery({ queryKey: ['ats-prompt', viewing], queryFn: () => get<{ prompt: Version & { content: string } }>(`/profile/ats-prompt/${viewing}`), enabled: Boolean(viewing) });

  if (q.isLoading || !q.data) return <Loading />;
  const active = q.data.active;
  // Un champ de saisie convertit les fins de ligne Windows (CRLF) : la comparaison se fait donc sans en tenir compte,
  // pour ne jamais proposer d'enregistrer une « nouvelle version » qui ne différerait que par cette conversion.
  const crlf = Boolean(active?.content.includes('\r'));
  const dirty = content.replace(/\r\n?/g, '\n') !== (active?.content ?? '').replace(/\r\n?/g, '\n');
  return (
    <div className="space-y-5">
      {active?.isDefault && (
        <Alert tone="warning" title="Prompt par défaut actif">
          Collez votre prompt ATS personnel ci-dessous : il remplacera le prompt fourni par défaut et sera exécuté tel quel.
        </Alert>
      )}
      <Card>
        <CardHeader
          icon={<ScanSearch className="size-4" />}
          title="Votre prompt ATS"
          description="Exécuté fidèlement pour chaque offre pertinente, avec votre CV et l'offre complète. Il n'est jamais réécrit, raccourci ni reformulé ; chaque analyse garde la trace de la version utilisée."
          action={active && <Badge tone="brand">Version {active.version} active</Badge>}
        />
        <div className="space-y-3 px-5 pb-5">
          <Textarea rows={18} value={content} onChange={(e) => setContent(e.target.value)} className="font-mono text-[12.5px]" spellCheck={false} />
          <p className="text-xs leading-relaxed text-slate-500">
            Seules les mentions « Copier/coller » des lignes « CV : » et « Offre d'emploi : » (ou {'{{CV}}'} et {'{{OFFRE}}'}) sont remplacées, par le texte de votre CV extrait de son document et par l'offre complète ; sans ces mentions, le CV et l'offre sont ajoutés après le prompt, intact. Avant chaque analyse, JobAgent retire le CV et l'offre du message assemblé et vérifie que l'empreinte SHA-256 du texte restant est exactement celle de la version enregistrée : sinon, l'analyse n'est pas lancée. Le PDF du CV est joint lorsque le fournisseur le permet.
          </p>
          {crlf && (
            <Alert tone="info" title="Fins de ligne Windows conservées">
              Cette version contient des fins de ligne Windows (CRLF), conservées telles quelles. Le champ ci-dessus les affiche comme de simples retours à la ligne : si vous modifiez le texte ici, la nouvelle version utilisera des retours à la ligne simples. Pour garder le fichier à l'identique, importez-le.
            </Alert>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Note de version (facultatif)" className="min-w-56 flex-1">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. ajout du critère « langues »" />
            </Field>
            <Button variant="primary" disabled={!dirty || !content.trim()} loading={save.isPending} onClick={() => save.mutate()}>
              Enregistrer une nouvelle version
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          icon={<ShieldCheck className="size-4" />}
          title="Intégrité du prompt"
          description="Importez le fichier d'origine pour l'enregistrer octet pour octet, ou comparez la version active à votre original : JobAgent calcule les deux empreintes SHA-256 et signale le moindre écart, caractère par caractère."
        />
        <div className="flex flex-wrap gap-2 px-5 pb-5">
          <input
            ref={importInput}
            type="file"
            accept=".txt,.md,.text,.docx,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile.mutate(f);
              e.target.value = '';
            }}
          />
          <input
            ref={compareInput}
            type="file"
            accept=".txt,.md,.text,.docx,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) compare.mutate(f);
              e.target.value = '';
            }}
          />
          <Button icon={<FileUp className="size-4" />} loading={importFile.isPending} onClick={() => importInput.current?.click()}>
            Importer le fichier d'origine
          </Button>
          <Button icon={<FileCheck2 className="size-4" />} loading={compare.isPending} disabled={!active} onClick={() => compareInput.current?.click()}>
            Comparer avec mon original
          </Button>
          {active && (
            <a className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50" href={`/api/profile/ats-prompt/${active.id}/raw`}>
              <Download className="size-4" /> Télécharger le texte exact
            </a>
          )}
        </div>
        {active && (
          <p className="px-5 pb-5 text-xs text-slate-500">
            Version active : <span className="font-mono break-all text-slate-700 select-all">SHA-256 {active.sha256}</span>. Pour la vérifier vous-même sur votre ordinateur : <span className="font-mono">sha256sum fichier.txt</span> (macOS : <span className="font-mono">shasum -a 256 fichier.txt</span>).
          </p>
        )}
      </Card>

      <Card>
        <CardHeader title="Historique des versions" description="Aucune version n'est supprimée. Vous pouvez revenir à une version précédente à tout moment." />
        <ul className="divide-y divide-slate-100 px-5 pb-3">
          {q.data.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-[13px]">
              <div className="min-w-0">
                <p className="font-medium text-slate-800">
                  Version {v.version} {v.isActive && <Badge tone="brand">Active</Badge>} {v.isDefault && <Badge>Par défaut</Badge>}
                </p>
                <p className="text-xs text-slate-500">
                  {formatDate(v.createdAt, true)} · {v.length.toLocaleString('fr-FR')} caractères
                  {v.note && ` · ${v.note}`}
                </p>
                <p className="font-mono text-[11px] break-all text-slate-400 select-all" title="Empreinte SHA-256 du texte enregistré">
                  SHA-256 {v.sha256}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setViewing(v.id)}>
                  Consulter
                </Button>
                {!v.isActive && (
                  <Button size="sm" loading={activate.isPending} onClick={() => activate.mutate(v.id)}>
                    Réactiver
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Modal open={Boolean(viewing)} onClose={() => setViewing(null)} wide title={`Prompt ATS — version ${viewed.data?.prompt.version ?? ''}`}>
        {viewed.isLoading ? <Loading /> : <pre className="font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-slate-700">{viewed.data?.prompt.content}</pre>}
        {viewing && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            <Button size="sm" icon={<FileCheck2 className="size-4" />} loading={compare.isPending} onClick={() => compareInput.current?.click()}>
              Comparer cette version avec mon original
            </Button>
            <a className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1 text-[13px] text-slate-700 hover:bg-slate-50" href={`/api/profile/ats-prompt/${viewing}/raw`}>
              <Download className="size-4" /> Texte exact
            </a>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(imported)} onClose={() => setImported(null)} title="Import du prompt">
        {imported && (
          <div className="space-y-3 text-[13px] text-slate-700">
            <Alert tone={imported.identicalToFile ? 'success' : 'warning'} title={imported.identicalToFile ? 'Enregistré octet pour octet' : 'Enregistré, avec une réserve'}>
              {imported.identicalToFile
                ? `L'empreinte du fichier « ${imported.file.name} » et celle de la version enregistrée sont identiques.`
                : "Le texte enregistré n'est pas la copie exacte des octets du fichier (voir ci-dessous)."}
            </Alert>
            <p>{imported.created ? `Version ${imported.prompt.version} créée et activée.` : 'Ce texte était déjà la version active : aucune nouvelle version.'}</p>
            <dl className="space-y-1 font-mono text-[11.5px] break-all">
              <div>Fichier : {imported.file.sha256}</div>
              <div>Enregistré : {imported.storedSha256}</div>
            </dl>
            {imported.notes.map((n) => (
              <p key={n} className="text-xs text-slate-500">
                {n}
              </p>
            ))}
          </div>
        )}
      </Modal>

      <Modal open={Boolean(comparison)} onClose={() => setComparison(null)} wide title="Comparaison avec votre original">
        {comparison && (
          <div className="space-y-3 text-[13px] text-slate-700">
            <Alert tone={comparison.identical ? 'success' : 'danger'} title={comparison.identical ? 'Identique, caractère pour caractère' : comparison.lineEndingsOnly ? 'Seules les fins de ligne diffèrent' : `${comparison.differences.length}${comparison.differences.length >= 20 ? '+' : ''} écart(s) détecté(s)`}>
              {comparison.identical
                ? `La version ${comparison.version.version} enregistrée est identique à votre original.`
                : comparison.lineEndingsOnly
                  ? "Le texte est le même, mais les fins de ligne diffèrent (Windows / Mac-Linux). Importez le fichier d'origine pour l'enregistrer à l'identique."
                  : "La version enregistrée ne correspond pas exactement à votre original. Importez votre fichier d'origine pour l'enregistrer tel quel."}
            </Alert>
            <dl className="space-y-1 font-mono text-[11.5px] break-all">
              <div>Votre original : {comparison.reference.sha256} ({comparison.reference.chars.toLocaleString('fr-FR')} caractères)</div>
              <div>
                Version {comparison.version.version} : {comparison.version.sha256} ({comparison.version.chars.toLocaleString('fr-FR')} caractères)
              </div>
              {!comparison.version.storedShaValid && <div className="text-red-700">Attention : le texte lu en base ne correspond plus à son empreinte enregistrée.</div>}
            </dl>
            {!comparison.identical && !comparison.lineEndingsOnly && (
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Ligne, colonne</th>
                    <th className="py-1 pr-2 font-medium">Votre original</th>
                    <th className="py-1 pr-2 font-medium">Version enregistrée</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {comparison.differences.map((d) => (
                    <tr key={d.position}>
                      <td className="py-1 pr-2 align-top">
                        {d.line}, {d.column}
                      </td>
                      <td className="py-1 pr-2 align-top break-all">{visible(d.expected)}</td>
                      <td className="py-1 pr-2 align-top break-all">{visible(d.actual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {comparison.notes.map((n) => (
              <p key={n} className="text-xs text-slate-500">
                {n}
              </p>
            ))}
            <p className="text-xs text-slate-400">Symboles : · espace, ⍽ espace insécable, ⇥ tabulation, ␍ ␊ fin de ligne, ∅ absent.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
