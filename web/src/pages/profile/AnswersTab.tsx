import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, CardHeader, EmptyState, Field, IconButton, Input, Loading, Modal, Select, Textarea, useToast } from '../../components/ui';
import { del, get, post, put } from '../../lib/api';
import { errorText } from '../../lib/hooks';

interface Answer {
  id: string;
  question: string;
  answer: string;
  scope: 'general' | 'country' | 'company' | 'job';
  scopeValue: string;
  status: string;
  usageCount: number;
  variants: string[];
}

const SCOPES = { general: 'Toutes les candidatures', country: 'Un pays', company: 'Une entreprise', job: 'Une offre' };

export function AnswersTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['answers'], queryFn: () => get<{ answers: Answer[] }>('/profile/answers') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ question: '', answer: '', scope: 'general' as Answer['scope'], scopeValue: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['answers'] });
  const create = useMutation({
    mutationFn: () => post('/profile/answers', form),
    onSuccess: () => {
      void refresh();
      setOpen(false);
      setForm({ question: '', answer: '', scope: 'general', scopeValue: '' });
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const update = useMutation({ mutationFn: (v: { id: string; answer: string }) => put(`/profile/answers/${v.id}`, { answer: v.answer }), onSuccess: () => { void refresh(); toast('Enregistré', 'success'); } });
  const remove = useMutation({ mutationFn: (id: string) => del(`/profile/answers/${id}`), onSuccess: refresh });

  if (q.isLoading) return <Loading />;
  const answers = q.data?.answers ?? [];
  return (
    <>
      <Card>
        <CardHeader
          icon={<MessageSquare className="size-4" />}
          title="Réponses standards"
          description="Les questions de formulaire auxquelles vous avez déjà répondu. Elles sont retrouvées même formulées autrement, et jamais reposées."
          action={
            <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
              Ajouter
            </Button>
          }
        />
        {answers.length === 0 ? (
          <EmptyState title="Aucune réponse enregistrée" description="Elles s'ajouteront au fil des candidatures : dès qu'un formulaire pose une question inconnue, l'agent vous la soumet une fois, puis réutilise votre réponse." />
        ) : (
          <ul className="divide-y divide-slate-100 px-5 pb-3">
            {answers.map((a) => (
              <li key={a.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[13px] font-medium text-slate-800">{a.question}</p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {a.scope !== 'general' && <Badge tone="info">{a.scopeValue}</Badge>}
                    {a.usageCount > 0 && <Badge>{a.usageCount} utilisation(s)</Badge>}
                    <IconButton label="Supprimer" onClick={() => remove.mutate(a.id)}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </div>
                </div>
                <Textarea className="mt-1.5" rows={Math.max(1, Math.ceil(a.answer.length / 100))} defaultValue={a.answer} onBlur={(e) => e.target.value !== a.answer && update.mutate({ id: a.id, answer: e.target.value })} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nouvelle réponse standard"
        footer={
          <Button variant="primary" disabled={!form.question.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Enregistrer
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Question">
            <Input value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder="Ex. Pourquoi souhaitez-vous rejoindre notre équipe ?" />
          </Field>
          <Field label="Votre réponse">
            <Textarea rows={5} value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="S'applique à">
              <Select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as Answer['scope'] })}>
                {Object.entries(SCOPES).filter(([k]) => k !== 'job').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            {form.scope !== 'general' && (
              <Field label={form.scope === 'country' ? 'Pays' : 'Entreprise'}>
                <Input value={form.scopeValue} onChange={(e) => setForm({ ...form, scopeValue: e.target.value })} />
              </Field>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
