import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FactDef, SalaryExpectation } from '../../../../src/shared/facts';
import { Alert, Badge, Button, Card, CardHeader, IconButton, Input, Loading, Select, TagInput, Textarea, useToast } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { errorText } from '../../lib/hooks';

interface FactRow {
  id: string;
  key: string;
  label: string;
  category: string;
  value: any;
  source: string;
  status: 'validated' | 'proposed';
}
interface Payload {
  categories: { id: string; label: string; description: string }[];
  catalog: FactDef[];
  facts: FactRow[];
}

const SOURCE: Record<string, string> = { cv_master: 'CV master', linkedin: 'LinkedIn', user: 'Vous', document: 'Document', other: 'Autre' };

function SalaryEditor({ value, onChange }: { value: SalaryExpectation[]; onChange: (v: SalaryExpectation[]) => void }) {
  const rows = value ?? [];
  const upd = (i: number, patch: Partial<SalaryExpectation>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input className="w-24" placeholder="Pays" value={r.country} onChange={(e) => upd(i, { country: e.target.value })} />
          <Input className="w-20" placeholder="Devise" value={r.currency} onChange={(e) => upd(i, { currency: e.target.value.toUpperCase() })} />
          <Input className="w-28" type="number" placeholder="Minimum" value={r.min ?? ''} onChange={(e) => upd(i, { min: e.target.value ? Number(e.target.value) : null })} />
          <Input className="w-28" type="number" placeholder="Maximum" value={r.max ?? ''} onChange={(e) => upd(i, { max: e.target.value ? Number(e.target.value) : null })} />
          <Select className="w-28" value={r.period} onChange={(e) => upd(i, { period: e.target.value as 'year' | 'month' })}>
            <option value="year">par an</option>
            <option value="month">par mois</option>
          </Select>
          <IconButton label="Supprimer" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { country: '', currency: 'EUR', min: null, max: null, period: 'year' }])}>
        Ajouter un pays
      </Button>
    </div>
  );
}

function FactField({ def, fact, proposed, onSave, onResolve }: { def: FactDef; fact?: FactRow; proposed?: FactRow; onSave: (value: unknown) => void; onResolve: (id: string, accept: boolean) => void }) {
  const [draft, setDraft] = useState<any>(fact?.value ?? (def.type === 'list' || def.type === 'salary_list' ? [] : ''));
  const key = JSON.stringify(fact?.value ?? null);
  useEffect(() => {
    setDraft(fact?.value ?? (def.type === 'list' || def.type === 'salary_list' ? [] : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const dirty = JSON.stringify(draft ?? '') !== JSON.stringify(fact?.value ?? (def.type === 'list' || def.type === 'salary_list' ? [] : ''));
  const commit = (v: unknown = draft) => {
    if (JSON.stringify(v ?? '') !== JSON.stringify(fact?.value ?? '')) onSave(v);
  };

  return (
    <div className="grid gap-1.5 py-3 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-slate-800">
          {def.label}
          {def.sensitive && <Badge tone="warning" className="ml-1.5">Sensible</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-slate-400">
          {fact ? `Source : ${SOURCE[fact.source] ?? fact.source}` : def.important ? <span className="font-medium text-amber-700">À renseigner</span> : 'Non renseigné'}
        </p>
      </div>
      <div className="min-w-0">
        {def.type === 'text' && <Input value={draft ?? ''} placeholder={def.hint} onChange={(e) => setDraft(e.target.value)} onBlur={() => commit()} />}
        {def.type === 'date' && <Input type="date" value={draft ?? ''} onChange={(e) => setDraft(e.target.value)} onBlur={() => commit()} />}
        {def.type === 'longtext' && <Textarea rows={3} value={draft ?? ''} placeholder={def.hint} onChange={(e) => setDraft(e.target.value)} onBlur={() => commit()} />}
        {def.type === 'boolean' && (
          <div className="flex gap-1.5">
            {[
              ['Oui', true],
              ['Non', false],
            ].map(([label, v]) => (
              <button
                key={String(v)}
                type="button"
                onClick={() => {
                  setDraft(v);
                  commit(v);
                }}
                className={`h-9 rounded-lg px-4 text-sm font-medium ring-1 ring-inset ${draft === v ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'}`}
              >
                {label as string}
              </button>
            ))}
          </div>
        )}
        {def.type === 'choice' && (
          <Select
            value={draft ?? ''}
            onChange={(e) => {
              setDraft(e.target.value);
              commit(e.target.value);
            }}
          >
            <option value="">—</option>
            {def.options?.map((o) => <option key={o}>{o}</option>)}
          </Select>
        )}
        {def.type === 'list' && (
          <TagInput
            value={Array.isArray(draft) ? draft : []}
            placeholder={def.hint}
            onChange={(v) => {
              setDraft(v);
              commit(v);
            }}
          />
        )}
        {def.type === 'salary_list' && (
          <div>
            <SalaryEditor value={Array.isArray(draft) ? draft : []} onChange={setDraft} />
            {dirty && (
              <Button size="sm" variant="primary" className="mt-2" onClick={() => commit()}>
                Enregistrer
              </Button>
            )}
          </div>
        )}
        {def.hint && def.type !== 'text' && def.type !== 'longtext' && def.type !== 'list' && <p className="mt-1 text-xs text-slate-500">{def.hint}</p>}
        {proposed && (
          <Alert
            tone="warning"
            title="Information contradictoire"
            action={
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => onResolve(proposed.id, false)}>
                  Garder la mienne
                </Button>
                <Button size="sm" variant="primary" onClick={() => onResolve(proposed.id, true)}>
                  Adopter
                </Button>
              </div>
            }
          >
            {SOURCE[proposed.source] ?? proposed.source} indique : « {typeof proposed.value === 'string' ? proposed.value : JSON.stringify(proposed.value)} »
          </Alert>
        )}
      </div>
    </div>
  );
}

export function FactsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['facts'], queryFn: () => get<Payload>('/profile/facts') });
  const save = useMutation({
    mutationFn: (v: { key: string; value: unknown }) => put('/profile/facts', v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facts'] });
      void qc.invalidateQueries({ queryKey: ['profile-summary'] });
      toast('Enregistré', 'success');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const resolve = useMutation({
    mutationFn: (v: { id: string; accept: boolean }) => post(`/profile/facts/${v.id}/resolve`, { accept: v.accept }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facts'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  if (q.isLoading || !q.data) return <Loading />;
  const validated = new Map(q.data.facts.filter((f) => f.status === 'validated').map((f) => [f.key, f]));
  const proposed = new Map(q.data.facts.filter((f) => f.status === 'proposed').map((f) => [f.key, f]));
  const skills = q.data.facts.filter((f) => f.status === 'validated' && f.key.startsWith('skill:'));
  const missing = q.data.catalog.filter((d) => d.important && !validated.has(d.key)).length;

  return (
    <div className="space-y-5">
      {missing > 0 && (
        <Alert tone="info" title={`${missing} information(s) fréquemment demandée(s) restent à renseigner`}>
          Chaque réponse est enregistrée une fois et réutilisée dans tous les formulaires. Une information absente n'est jamais devinée : l'agent vous la demandera.
        </Alert>
      )}
      {q.data.categories
        .filter((c) => c.id !== 'skills' && c.id !== 'other')
        .map((cat) => {
          const defs = q.data!.catalog.filter((d) => d.category === cat.id);
          if (!defs.length) return null;
          return (
            <Card key={cat.id}>
              <CardHeader title={cat.label} description={cat.description || undefined} />
              <div className="divide-y divide-slate-100 px-5 pb-2">
                {defs.map((def) => (
                  <FactField key={def.key} def={def} fact={validated.get(def.key)} proposed={proposed.get(def.key)} onSave={(value) => save.mutate({ key: def.key, value })} onResolve={(id, accept) => resolve.mutate({ id, accept })} />
                ))}
              </div>
            </Card>
          );
        })}
      {skills.length > 0 && (
        <Card>
          <CardHeader title="Compétences précisées" description="Vos réponses aux questions de l'agent. Une compétence marquée « non maîtrisée » ne sera jamais revendiquée." />
          <ul className="flex flex-wrap gap-2 px-5 pb-5">
            {skills.map((s) => (
              <li key={s.key}>
                <Badge tone={s.value.has ? 'success' : 'danger'} title={s.value.context}>
                  {s.value.name} · {s.value.has ? 'confirmée' : 'non maîtrisée'}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
