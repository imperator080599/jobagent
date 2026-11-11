// Éditeur structuré d'un CV (brouillon). Chaque valeur reste un extrait du
// document importé : l'éditeur sert à corriger la structure, pas à réécrire le parcours.
import { ArrowDown, ArrowUp, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CvData } from '../../../src/shared/cv';
import { Button, Field, IconButton, Input, Textarea } from './ui';

type Warning = { path: string; value: string; coverage: number };

function move<T>(list: T[], index: number, delta: number): T[] {
  const next = [...list];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function Section({ title, children, onAdd, addLabel }: { title: string; children: ReactNode; onAdd?: () => void; addLabel?: string }) {
  return (
    <section className="border-t border-slate-100 pt-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold tracking-wide text-slate-500 uppercase">{title}</h3>
        {onAdd && (
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={onAdd}>
            {addLabel ?? 'Ajouter'}
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

function RowTools({ onUp, onDown, onRemove }: { onUp: () => void; onDown: () => void; onRemove: () => void }) {
  return (
    <div className="flex shrink-0 items-center">
      <IconButton label="Monter" onClick={onUp}>
        <ArrowUp className="size-3.5" />
      </IconButton>
      <IconButton label="Descendre" onClick={onDown}>
        <ArrowDown className="size-3.5" />
      </IconButton>
      <IconButton label="Supprimer" onClick={onRemove} className="hover:text-rose-600">
        <Trash2 className="size-3.5" />
      </IconButton>
    </div>
  );
}

function BulletList({ items, onChange, warnings, placeholder }: { items: { id: string; text: string }[]; onChange: (v: { id: string; text: string }[]) => void; warnings: Map<string, Warning>; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      {items.map((b, i) => {
        const w = warnings.get(b.id);
        return (
          <div key={b.id || `new-${i}`}>
            <div className="flex items-start gap-1">
              <span className="mt-2.5 text-slate-300">•</span>
              <Textarea rows={Math.max(1, Math.ceil(b.text.length / 95))} value={b.text} placeholder={placeholder} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className={w ? 'ring-amber-300' : ''} />
              <RowTools onUp={() => onChange(move(items, i, -1))} onDown={() => onChange(move(items, i, 1))} onRemove={() => onChange(items.filter((_, j) => j !== i))} />
            </div>
            {w && (
              <p className="mt-0.5 ml-4 flex items-center gap-1 text-xs text-amber-700">
                <TriangleAlert className="size-3" /> À vérifier : ce texte ne correspond pas exactement au document importé.
              </p>
            )}
          </div>
        );
      })}
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...items, { id: '', text: '' }])}>
        Ajouter une ligne
      </Button>
    </div>
  );
}

export function CvEditor({ value, onChange, warnings = [] }: { value: CvData; onChange: (v: CvData) => void; warnings?: Warning[] }) {
  const wmap = new Map(warnings.map((w) => [w.path, w]));
  const set = (patch: Partial<CvData>) => onChange({ ...value, ...patch });
  const idn = value.identity;
  const setId = (k: keyof typeof idn, v: string) => set({ identity: { ...idn, [k]: v } });
  const dateHint = 'AAAA-MM, AAAA ou present';

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nom complet">
          <Input value={idn.fullName} onChange={(e) => setId('fullName', e.target.value)} />
        </Field>
        <Field label="Titre">
          <Input value={idn.headline ?? ''} onChange={(e) => setId('headline', e.target.value)} />
        </Field>
        <Field label="Email">
          <Input value={idn.email ?? ''} onChange={(e) => setId('email', e.target.value)} />
        </Field>
        <Field label="Téléphone">
          <Input value={idn.phone ?? ''} onChange={(e) => setId('phone', e.target.value)} />
        </Field>
        <Field label="Localisation">
          <Input value={idn.location ?? ''} onChange={(e) => setId('location', e.target.value)} />
        </Field>
        <Field label="LinkedIn">
          <Input value={idn.linkedin ?? ''} onChange={(e) => setId('linkedin', e.target.value)} />
        </Field>
      </div>
      <Field label="Profil / accroche">
        <Textarea rows={3} value={value.summary ?? ''} onChange={(e) => set({ summary: e.target.value })} />
      </Field>

      <Section
        title="Expériences"
        onAdd={() => set({ experiences: [...value.experiences, { id: '', company: '', title: '', location: '', start: '', end: '', dates: '', contract: '', summary: '', bullets: [] }] })}
        addLabel="Ajouter une expérience"
      >
        <div className="space-y-4">
          {value.experiences.map((e, i) => {
            const upd = (patch: Partial<typeof e>) => set({ experiences: value.experiences.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={e.id || `new-${i}`} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
                <div className="flex items-start gap-2">
                  <div className="grid flex-1 gap-2 sm:grid-cols-6">
                    <Input className="sm:col-span-3" placeholder="Entreprise" value={e.company} onChange={(ev) => upd({ company: ev.target.value })} />
                    <Input className="sm:col-span-3" placeholder="Intitulé du poste" value={e.title} onChange={(ev) => upd({ title: ev.target.value })} />
                    <Input className="sm:col-span-2" placeholder="Lieu" value={e.location ?? ''} onChange={(ev) => upd({ location: ev.target.value })} />
                    <Input className="sm:col-span-2" placeholder={`Début (${dateHint})`} value={e.start ?? ''} onChange={(ev) => upd({ start: ev.target.value })} />
                    <Input className="sm:col-span-2" placeholder={`Fin (${dateHint})`} value={e.end ?? ''} onChange={(ev) => upd({ end: ev.target.value })} />
                  </div>
                  <RowTools onUp={() => set({ experiences: move(value.experiences, i, -1) })} onDown={() => set({ experiences: move(value.experiences, i, 1) })} onRemove={() => set({ experiences: value.experiences.filter((_, j) => j !== i) })} />
                </div>
                <div className="mt-2">
                  <BulletList items={e.bullets} onChange={(bullets) => upd({ bullets })} warnings={wmap} placeholder="Mission ou réalisation" />
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Formation" onAdd={() => set({ education: [...value.education, { id: '', school: '', degree: '', field: '', location: '', start: '', end: '', dates: '', details: [] }] })} addLabel="Ajouter une formation">
        <div className="space-y-4">
          {value.education.map((e, i) => {
            const upd = (patch: Partial<typeof e>) => set({ education: value.education.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={e.id || `new-${i}`} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
                <div className="flex items-start gap-2">
                  <div className="grid flex-1 gap-2 sm:grid-cols-6">
                    <Input className="sm:col-span-3" placeholder="École" value={e.school} onChange={(ev) => upd({ school: ev.target.value })} />
                    <Input className="sm:col-span-3" placeholder="Diplôme" value={e.degree} onChange={(ev) => upd({ degree: ev.target.value })} />
                    <Input className="sm:col-span-2" placeholder="Lieu" value={e.location ?? ''} onChange={(ev) => upd({ location: ev.target.value })} />
                    <Input className="sm:col-span-2" placeholder="Début" value={e.start ?? ''} onChange={(ev) => upd({ start: ev.target.value })} />
                    <Input className="sm:col-span-2" placeholder="Fin" value={e.end ?? ''} onChange={(ev) => upd({ end: ev.target.value })} />
                  </div>
                  <RowTools onUp={() => set({ education: move(value.education, i, -1) })} onDown={() => set({ education: move(value.education, i, 1) })} onRemove={() => set({ education: value.education.filter((_, j) => j !== i) })} />
                </div>
                <div className="mt-2">
                  <BulletList items={e.details} onChange={(details) => upd({ details })} warnings={wmap} placeholder="Précision (spécialisation, mention…)" />
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Compétences" onAdd={() => set({ skills: [...value.skills, { id: '', label: '', items: [] }] })} addLabel="Ajouter un groupe">
        <div className="space-y-2">
          {value.skills.map((g, i) => (
            <div key={g.id || `new-${i}`} className="flex items-start gap-2">
              <Input className="w-40 shrink-0" placeholder="Libellé" value={g.label} onChange={(e) => set({ skills: value.skills.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <Textarea
                rows={Math.max(1, Math.ceil(g.items.join(' ; ').length / 80))}
                placeholder="Éléments séparés par des points-virgules"
                value={g.items.join(' ; ')}
                onChange={(e) => set({ skills: value.skills.map((x, j) => (j === i ? { ...x, items: e.target.value.split(/\s*;\s*/).filter((s, k, arr) => s || k === arr.length - 1) } : x)) })}
              />
              <IconButton label="Supprimer" onClick={() => set({ skills: value.skills.filter((_, j) => j !== i) })} className="hover:text-rose-600">
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Langues" onAdd={() => set({ languages: [...value.languages, { id: '', language: '', level: '', certification: '' }] })} addLabel="Ajouter une langue">
        <div className="space-y-2">
          {value.languages.map((l, i) => {
            const upd = (patch: Partial<typeof l>) => set({ languages: value.languages.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={l.id || `new-${i}`} className="flex items-center gap-2">
                <Input placeholder="Langue" value={l.language} onChange={(e) => upd({ language: e.target.value })} />
                <Input placeholder="Niveau" value={l.level ?? ''} onChange={(e) => upd({ level: e.target.value })} />
                <Input placeholder="Certification" value={l.certification ?? ''} onChange={(e) => upd({ certification: e.target.value })} />
                <IconButton label="Supprimer" onClick={() => set({ languages: value.languages.filter((_, j) => j !== i) })} className="hover:text-rose-600">
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Certifications" onAdd={() => set({ certifications: [...value.certifications, { id: '', name: '', issuer: '', date: '' }] })} addLabel="Ajouter une certification">
        <div className="space-y-2">
          {value.certifications.map((c, i) => {
            const upd = (patch: Partial<typeof c>) => set({ certifications: value.certifications.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={c.id || `new-${i}`} className="flex items-center gap-2">
                <Input placeholder="Certification" value={c.name} onChange={(e) => upd({ name: e.target.value })} />
                <Input placeholder="Organisme" value={c.issuer ?? ''} onChange={(e) => upd({ issuer: e.target.value })} />
                <Input className="w-28 shrink-0" placeholder="Date" value={c.date ?? ''} onChange={(e) => upd({ date: e.target.value })} />
                <IconButton label="Supprimer" onClick={() => set({ certifications: value.certifications.filter((_, j) => j !== i) })} className="hover:text-rose-600">
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Autres rubriques" onAdd={() => set({ extras: [...value.extras, { id: '', title: '', items: [] }] })} addLabel="Ajouter une rubrique">
        <div className="space-y-4">
          {value.extras.map((x, i) => {
            const upd = (patch: Partial<typeof x>) => set({ extras: value.extras.map((y, j) => (j === i ? { ...y, ...patch } : y)) });
            return (
              <div key={x.id || `new-${i}`} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
                <div className="mb-2 flex items-center gap-2">
                  <Input placeholder="Titre de la rubrique" value={x.title} onChange={(e) => upd({ title: e.target.value })} />
                  <IconButton label="Supprimer la rubrique" onClick={() => set({ extras: value.extras.filter((_, j) => j !== i) })} className="hover:text-rose-600">
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
                <BulletList items={x.items} onChange={(items) => upd({ items })} warnings={wmap} />
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
