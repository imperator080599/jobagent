// Messagerie : connexion Gmail par OAuth. Lecture et rédaction sont deux autorisations
// distinctes, accordées sur la page de Google ; aucun mot de passe n'est demandé.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Mail, PenLine, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, Switch, useToast } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { formatDate, relativeTime } from '../../lib/format';
import { errorText, useSetting } from '../../lib/hooks';
import { SecretField } from '../Settings';

interface Status {
  gmail: { clientId: string; account: string; canRead: boolean; canCompose: boolean; connectedAt: string; allowSend: boolean; lookbackDays: number; importAlerts: boolean; clientSecretConfigured: boolean; connected: boolean; redirectUri: string };
  schedule: { enabled: boolean; intervalMinutes: number };
  lastSyncAt: string | null;
}

export function MailSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['mail', 'status'], queryFn: () => get<Status>('/mail/status') });
  const schedule = useSetting('schedule.email');
  const [clientId, setClientId] = useState('');
  useEffect(() => {
    if (q.data) setClientId(q.data.gmail.clientId);
  }, [q.data?.gmail.clientId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Retour de Google : message de confirmation ou d'erreur.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const result = p.get('gmail');
    if (!result) return;
    toast(result === 'ok' ? 'Gmail est connecté. Première lecture en cours.' : (p.get('message') ?? "La connexion n'a pas abouti."), result === 'ok' ? 'success' : 'danger');
    window.history.replaceState(null, '', window.location.pathname);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => void qc.invalidateQueries({ queryKey: ['mail'] });
  const onError = (e: unknown) => toast(errorText(e), 'danger');
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => put('/mail/gmail/settings', body), onSuccess: refresh, onError });
  const start = useMutation({ mutationFn: (access: 'read' | 'compose') => post<{ url: string }>('/mail/gmail/start', { access }), onSuccess: (d) => window.location.assign(d.url), onError });
  const disconnect = useMutation({ mutationFn: () => post('/mail/gmail/disconnect'), onSuccess: () => { toast('Accès révoqué.'); refresh(); }, onError });
  const sync = useMutation({ mutationFn: () => post('/mail/sync'), onSuccess: () => toast('Lecture lancée.'), onError });
  if (q.isLoading || !q.data) return <Loading />;
  const g = q.data.gmail;
  const ready = Boolean(g.clientId) && g.clientSecretConfigured;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          icon={<Mail className="size-4" />}
          title="Gmail"
          description="Pour suivre les réponses à vos candidatures : accusés de réception, propositions d'entretien, refus. Seuls les messages liés à votre recherche d'emploi sont lus ; les pièces jointes ne le sont jamais."
          action={g.connected ? <Badge tone="success"><CircleCheck className="size-3" /> Connecté</Badge> : <Badge>Non connecté</Badge>}
        />
        <div className="space-y-4 px-5 pb-5">
          {g.connected ? (
            <>
              <div className="rounded-xl bg-slate-50 p-3 text-[13px] text-slate-700">
                <p><span className="font-medium text-slate-900">{g.account}</span> — connecté le {formatDate(g.connectedAt)}{q.data.lastSyncAt ? ` · dernière lecture ${relativeTime(q.data.lastSyncAt)}` : ''}</p>
                <ul className="mt-2 space-y-1">
                  <li className="flex items-center gap-2"><ShieldCheck className="size-4 text-emerald-600" /> Lecture des messages liés à vos candidatures</li>
                  <li className="flex items-center gap-2">{g.canCompose ? <ShieldCheck className="size-4 text-emerald-600" /> : <PenLine className="size-4 text-slate-400" />} Rédaction de brouillons {g.canCompose ? '(accordée)' : '(non accordée)'}</li>
                </ul>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button icon={<RefreshCw className="size-4" />} loading={sync.isPending} onClick={() => sync.mutate()}>Lire maintenant</Button>
                {!g.canCompose && <Button icon={<PenLine className="size-4" />} loading={start.isPending} onClick={() => start.mutate('compose')}>Autoriser aussi les brouillons</Button>}
                <Button variant="danger" icon={<Unplug className="size-4" />} loading={disconnect.isPending} onClick={() => window.confirm("Révoquer l'accès à Gmail ? Les emails déjà rattachés à vos candidatures sont conservés.") && disconnect.mutate()}>Révoquer l'accès</Button>
              </div>
              {g.canCompose && (
                <Alert tone="info">
                  Les réponses et relances préparées sont déposées dans vos brouillons Gmail. Rien n'est jamais envoyé à votre place : vous relisez et envoyez depuis votre messagerie.
                </Alert>
              )}
            </>
          ) : (
            <>
              <Alert tone="info" title="Mise en place (une seule fois, environ cinq minutes)">
                <ol className="list-decimal space-y-1 pl-4">
                  <li>Dans la console Google Cloud, créez un projet, activez « Gmail API » et configurez l'écran de consentement (type « Externe », état de publication « En production » pour éviter une expiration hebdomadaire de l'accès).</li>
                  <li>Créez un identifiant « ID client OAuth » de type « Application Web », avec cette adresse de redirection autorisée : <code className="rounded bg-white px-1 py-0.5 text-[12px] break-all">{g.redirectUri}</code></li>
                  <li>Copiez ci-dessous l'identifiant client et le secret client, puis connectez votre compte.</li>
                </ol>
              </Alert>
              <Field label="Identifiant client OAuth" hint="Se termine par .apps.googleusercontent.com">
                <div className="flex gap-2">
                  <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234567890-abc.apps.googleusercontent.com" />
                  <Button variant="primary" disabled={clientId.trim() === g.clientId} loading={save.isPending} onClick={() => save.mutate({ clientId: clientId.trim() })}>Enregistrer</Button>
                </div>
              </Field>
              <SecretField secretKey="google_client_secret" label="Secret client OAuth" hint="Chiffré, jamais réaffiché." />
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={!ready} loading={start.isPending && start.variables === 'read'} onClick={() => start.mutate('read')}>Connecter Gmail en lecture seule</Button>
                <Button disabled={!ready} loading={start.isPending && start.variables === 'compose'} onClick={() => start.mutate('compose')}>Connecter avec la rédaction de brouillons</Button>
              </div>
              <p className="text-[12.5px] text-slate-500">Vous êtes redirigé vers la page d'autorisation de Google : votre mot de passe n'est jamais saisi ici. L'accès se révoque à tout moment, ici ou dans votre compte Google.</p>
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Réglages de lecture" />
        <div className="space-y-4 px-5 pb-5">
          <Switch checked={schedule.value?.enabled ?? false} disabled={!g.connected} onChange={(enabled) => schedule.save({ ...(schedule.value ?? { intervalMinutes: 30 }), enabled })} label="Lire automatiquement les nouveaux messages" description={`Toutes les ${schedule.value?.intervalMinutes ?? 30} minutes, même ordinateur éteint.`} />
          <Switch checked={g.importAlerts} onChange={(importAlerts) => save.mutate({ importAlerts })} label="Importer les offres de mes alertes email" description="Les offres citées dans vos alertes (LinkedIn, Indeed, Welcome to the Jungle…) sont ajoutées à votre liste. Leur texte complet reste à coller avant toute analyse : ces sites ne sont jamais lus automatiquement." />
          <Field label="Profondeur de la première lecture" hint="En jours.">
            <div className="w-28"><Input type="number" min={1} max={180} defaultValue={g.lookbackDays} onBlur={(e) => Number(e.target.value) !== g.lookbackDays && save.mutate({ lookbackDays: Math.max(1, Math.min(180, Number(e.target.value) || 30)) })} /></div>
          </Field>
        </div>
      </Card>
    </div>
  );
}
