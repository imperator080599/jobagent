// Règles AUTOPILOT : validées une fois, elles permettent l'envoi des candidatures sans
// validation individuelle — jamais au-delà de ce que chaque plateforme permet.
import { useQuery } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { Field, Select, Switch, TagInput } from '../../components/ui';
import { get } from '../../lib/api';
import { NumberField, SettingCard } from '../Settings';

interface Policy {
  id: string;
  name: string;
  autonomy: 'auto' | 'prefill' | 'manual';
  limits: string[];
  evidence: { url: string; quote: string; checkedAt: string }[];
}

const RANK = { manual: 0, prefill: 1, auto: 2 } as const;
const CAP_LABEL = { auto: 'envoi automatique permis', prefill: 'remplissage seulement', manual: 'aucune automatisation' } as const;

export function AutopilotSettings() {
  const platforms = useQuery({ queryKey: ['apply', 'platforms'], queryFn: () => get<{ platforms: Policy[] }>('/apply/platforms') });
  return (
    <SettingCard
      settingKey="application.autopilot"
      icon={<Rocket className="size-4" />}
      title="AUTOPILOT : envoi automatique sous vos règles"
      description="Une candidature qui remplit toutes ces règles est remplie, accompagnée de ses documents validés et envoyée sans validation individuelle. Les autres passent en mode VALIDATION. Une plateforme qui interdit l'automatisation n'est jamais automatisée, quel que soit le réglage."
    >
      {(v, set) => (
        <div className="space-y-5">
          <Switch checked={v.enabled} onChange={(enabled) => set({ ...v, enabled })} label="Activer AUTOPILOT" description="Désactivé : JobAgent remplit les formulaires, et l'envoi vous revient (mode VALIDATION)." />
          <div>
            <p className="text-[13px] font-medium text-slate-800">Plateformes</p>
            <p className="text-xs text-slate-500">Le plafond vient des conditions de chaque plateforme (preuves dans Recherche → Couverture). Vous pouvez automatiser moins, jamais plus.</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(platforms.data?.platforms ?? [])
                .filter((p) => p.id !== 'email' && p.autonomy !== 'manual')
                .map((p) => {
                  const current = (v.platforms[p.id] as Policy['autonomy'] | undefined) ?? 'prefill';
                  return (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 ring-1 ring-slate-200">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] text-slate-800">{p.name}</p>
                        <p className="text-[11px] text-slate-400">
                          {CAP_LABEL[p.autonomy]}
                          {p.evidence[0] && (
                            <>
                              {' · '}
                              <a className="underline" href={p.evidence[0].url} target="_blank" rel="noreferrer">
                                preuve
                              </a>
                            </>
                          )}
                        </p>
                      </div>
                      <Select className="!w-48 shrink-0" value={current} onChange={(e) => set({ ...v, platforms: { ...v.platforms, [p.id]: e.target.value as Policy['autonomy'] } })} aria-label={`Automatisation ${p.name}`}>
                        <option value="auto" disabled={RANK[p.autonomy] < RANK.auto}>
                          Remplir et envoyer
                        </option>
                        <option value="prefill">Remplir, j’envoie</option>
                        <option value="manual">Ne rien automatiser</option>
                      </Select>
                    </div>
                  );
                })}
            </div>
            <p className="mt-2 text-[12px] text-slate-500">
              Préparation seulement (conditions d’utilisation ou accès non vérifié) :{' '}
              {(platforms.data?.platforms ?? [])
                .filter((p) => p.autonomy === 'manual')
                .map((p, i, all) => (
                  <span key={p.id}>
                    {p.evidence[0] ? (
                      <a className="underline" href={p.evidence[0].url} target="_blank" rel="noreferrer" title={p.evidence[0].quote}>
                        {p.name}
                      </a>
                    ) : (
                      p.name
                    )}
                    {i < all.length - 1 ? ', ' : '.'}
                  </span>
                ))}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Pays autorisés" hint="Codes ou noms de pays (vide = tous).">
              <TagInput value={v.countries} onChange={(countries) => set({ ...v, countries })} placeholder="FR, LU, GB…" />
            </Field>
            <Field label="Contrats autorisés" hint="Vide = tous.">
              <TagInput value={v.contracts} onChange={(contracts) => set({ ...v, contracts })} placeholder="CDI, VIE…" />
            </Field>
            <Field label="Intitulés visés" hint="L'intitulé doit contenir l'un de ces termes (vide = tous).">
              <TagInput value={v.titleKeywords} onChange={(titleKeywords) => set({ ...v, titleKeywords })} placeholder="Transaction Services, M&A…" />
            </Field>
            <Field label="Mots exclus" hint="Aucun envoi automatique si l'offre contient l'un de ces termes.">
              <TagInput value={v.excludeKeywords} onChange={(excludeKeywords) => set({ ...v, excludeKeywords })} placeholder="stage, alternance…" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <NumberField label="Note ATS attribuée minimale" value={v.minAtsScore} min={0} max={20} step={0.5} suffix="/20" onChange={(n) => set({ ...v, minAtsScore: n })} />
            <NumberField label="Priorité minimale" value={v.minPriority} min={0} max={100} suffix="/100" onChange={(n) => set({ ...v, minPriority: n })} />
            <NumberField label="Envois par jour" value={v.maxPerDay} min={0} max={50} onChange={(n) => set({ ...v, maxPerDay: n })} />
            <NumberField label="Envois sur 7 jours" value={v.maxPerWeek} min={0} max={200} onChange={(n) => set({ ...v, maxPerWeek: n })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Switch checked={v.requireLetter} onChange={(requireLetter) => set({ ...v, requireLetter })} label="Exiger une lettre validée" />
            <Switch checked={v.allowDerivedAnswers} onChange={(allowDerivedAnswers) => set({ ...v, allowDerivedAnswers })} label="Réponses déduites de faits vérifiables" description="Ex. « comment avez-vous connu l'offre » = sa source réelle ; « déjà employé ici » d'après votre CV." />
            <Switch checked={v.allowLetterAnswers} onChange={(allowLetterAnswers) => set({ ...v, allowLetterAnswers })} label="Questions de motivation : reprendre ma lettre validée" />
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-[13px] font-medium text-slate-800">Consentements que JobAgent peut donner en votre nom</p>
            <p className="text-xs text-slate-500">Sans votre accord ici, ces cases vous sont laissées et l'envoi automatique s'arrête avant elles.</p>
            <div className="mt-2 grid gap-3">
              <Switch checked={v.consents.privacyPolicy} onChange={(privacyPolicy) => set({ ...v, consents: { ...v.consents, privacyPolicy } })} label="Accepter la politique de confidentialité du recruteur" description="Traitement de vos données pour la candidature." />
              <Switch checked={v.consents.accuracyAttestation} onChange={(accuracyAttestation) => set({ ...v, consents: { ...v.consents, accuracyAttestation } })} label="Certifier l'exactitude des informations transmises" description="Toutes les réponses viennent de votre profil validé ; aucune n'est inventée." />
              <Switch checked={v.consents.declineDemographics} onChange={(declineDemographics) => set({ ...v, consents: { ...v.consents, declineDemographics } })} label="Questionnaires de diversité : « je ne souhaite pas répondre »" />
            </div>
          </div>
        </div>
      )}
    </SettingCard>
  );
}
