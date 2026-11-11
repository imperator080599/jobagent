import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanSearch } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, Modal, Textarea, useToast } from '../../components/ui';
import { get, post } from '../../lib/api';
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
  const viewed = useQuery({ queryKey: ['ats-prompt', viewing], queryFn: () => get<{ prompt: Version & { content: string } }>(`/profile/ats-prompt/${viewing}`), enabled: Boolean(viewing) });

  if (q.isLoading || !q.data) return <Loading />;
  const active = q.data.active;
  const dirty = content !== (active?.content ?? '');
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
            Si votre prompt contient des emplacements du type « CV : Copier/coller » et « Offre d'emploi : Copier/coller » (ou {'{{CV}}'} et {'{{OFFRE}}'}), le CV et l'offre y sont insérés ; sinon ils sont ajoutés à la suite. Le fichier PDF du CV est également joint pour l'évaluation du format.
          </p>
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
        <CardHeader title="Historique des versions" description="Aucune version n'est supprimée. Vous pouvez revenir à une version précédente à tout moment." />
        <ul className="divide-y divide-slate-100 px-5 pb-3">
          {q.data.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-[13px]">
              <div className="min-w-0">
                <p className="font-medium text-slate-800">
                  Version {v.version} {v.isActive && <Badge tone="brand">Active</Badge>} {v.isDefault && <Badge>Par défaut</Badge>}
                </p>
                <p className="text-xs text-slate-500">
                  {formatDate(v.createdAt, true)} · {v.length.toLocaleString('fr-FR')} caractères · empreinte {v.sha256.slice(0, 10)}
                  {v.note && ` · ${v.note}`}
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
      </Modal>
    </div>
  );
}
