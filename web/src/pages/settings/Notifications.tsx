// Notifications : canaux, événements signalés sans attendre, résumé quotidien.
import { useMutation, useQuery } from '@tanstack/react-query';
import { BellRing, Send } from 'lucide-react';
import { Button, Card, CardHeader, Field, Input, Loading, Switch, useToast } from '../../components/ui';
import { get, post } from '../../lib/api';
import { errorText, useSetting } from '../../lib/hooks';
import { SecretField } from '../Settings';

const EVENTS: [string, string][] = [['interview', "Proposition d'entretien"], ['offer', "Proposition d'embauche"], ['recruiter_request', "Demande d'un recruteur"], ['source_down', 'Source en panne'], ['budget_reached', 'Budget IA atteint']];

export function NotificationsSettings() {
  const toast = useToast();
  const channels = useSetting('notifications.channels');
  const immediate = useSetting('notifications.immediate');
  const digest = useSetting('schedule.digest');
  const preview = useQuery({ queryKey: ['settings', 'digest'], queryFn: () => get<{ title: string; body: string }>('/settings/notifications/digest') });
  const test = useMutation({
    mutationFn: () => post<{ sent: number; failed: string[] }>('/settings/notifications/test'),
    onSuccess: (d) => toast(d.failed.length ? `Échec : ${d.failed.join(' ; ')}` : `Message d'essai envoyé sur ${d.sent} canal(aux).`, d.failed.length ? 'danger' : 'success'),
    onError: (e) => toast(errorText(e), 'danger'),
  });
  if (!channels.value || !immediate.value || !digest.value) return <Loading />;
  const c = channels.value;
  const set = (patch: Partial<typeof c>) => channels.save({ ...c, ...patch });
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader icon={<BellRing className="size-4" />} title="Canaux" description="Où vous prévenir. Tout reste visible dans l'application, canal activé ou non." action={<Button size="sm" icon={<Send className="size-4" />} loading={test.isPending} onClick={() => test.mutate()}>Envoyer un essai</Button>} />
        <div className="space-y-5 px-5 pb-5">
          <div className="space-y-2">
            <Switch checked={c.ntfy.enabled} onChange={(enabled) => set({ ntfy: { ...c.ntfy, enabled } })} label="ntfy (notification sur téléphone)" description="Installez l'application ntfy, abonnez-vous à un sujet au nom difficile à deviner, et indiquez-le ici." />
            {c.ntfy.enabled && (
              <div className="grid gap-3 pl-12 sm:grid-cols-2">
                <Field label="Serveur"><Input defaultValue={c.ntfy.server} onBlur={(e) => e.target.value !== c.ntfy.server && set({ ntfy: { ...c.ntfy, server: e.target.value.trim() } })} /></Field>
                <Field label="Sujet"><Input defaultValue={c.ntfy.topic} placeholder="jobagent-a8f3k2…" onBlur={(e) => e.target.value !== c.ntfy.topic && set({ ntfy: { ...c.ntfy, topic: e.target.value.trim() } })} /></Field>
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Switch checked={c.telegram.enabled} onChange={(enabled) => set({ telegram: { ...c.telegram, enabled } })} label="Telegram" description="Créez un bot avec @BotFather, puis indiquez son jeton et l'identifiant de votre conversation." />
            {c.telegram.enabled && (
              <div className="grid gap-3 pl-12 sm:grid-cols-2">
                <Field label="Identifiant de conversation (chat id)"><Input defaultValue={c.telegram.chatId} onBlur={(e) => e.target.value !== c.telegram.chatId && set({ telegram: { ...c.telegram, chatId: e.target.value.trim() } })} /></Field>
                <SecretField secretKey="telegram_bot_token" label="Jeton du bot" />
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Switch checked={c.webhook.enabled} onChange={(enabled) => set({ webhook: { ...c.webhook, enabled } })} label="Webhook" description="Pour relier un autre outil (Make, Zapier, Slack…). Chaque notification est envoyée en JSON." />
            {c.webhook.enabled && (
              <div className="grid gap-3 pl-12 sm:grid-cols-2">
                <Field label="Adresse"><Input type="url" defaultValue={c.webhook.url} placeholder="https://…" onBlur={(e) => e.target.value !== c.webhook.url && set({ webhook: { ...c.webhook, url: e.target.value.trim() } })} /></Field>
                <SecretField secretKey="webhook_secret" label="Secret de signature (facultatif)" hint="Signe chaque envoi (en-tête x-jobagent-signature)." />
              </div>
            )}
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Prévenir sans attendre" description="Le reste est regroupé dans le résumé quotidien." />
        <div className="space-y-3 px-5 pb-5">
          {EVENTS.map(([id, label]) => (
            <Switch key={id} checked={immediate.value!.includes(id)} onChange={(on) => immediate.save(on ? [...immediate.value!, id] : immediate.value!.filter((x) => x !== id))} label={label} />
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader title="Résumé quotidien" description="Envoyé une fois par jour sur les canaux actifs." />
        <div className="space-y-4 px-5 pb-5">
          <div className="flex flex-wrap items-end gap-4">
            <Switch checked={digest.value.enabled} onChange={(enabled) => digest.save({ ...digest.value!, enabled })} label="Activer" />
            <Field label="Heure d'envoi (votre fuseau)">
              <Input type="time" className="w-32" defaultValue={`${String(digest.value.hour).padStart(2, '0')}:${String(digest.value.minute).padStart(2, '0')}`} onBlur={(e) => { const [h, m] = e.target.value.split(':').map(Number); if (h !== undefined && m !== undefined && (h !== digest.value!.hour || m !== digest.value!.minute)) digest.save({ ...digest.value!, hour: h, minute: m }); }} />
            </Field>
          </div>
          {preview.data && (
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="text-[12px] font-medium text-slate-500">Aperçu du résumé d'aujourd'hui</p>
              <p className="mt-1 text-[13px] font-semibold text-slate-900">{preview.data.title}</p>
              <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-slate-700">{preview.data.body}</p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
