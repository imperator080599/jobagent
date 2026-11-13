// Données : export complet, effacement, rappel de ce qui est stocké et protégé.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, CardHeader, Field, Input, Modal, useToast } from '../../components/ui';
import { post } from '../../lib/api';
import { errorText } from '../../lib/hooks';

export function DataSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const [scope, setScope] = useState<null | 'search' | 'all'>(null);
  const [password, setPassword] = useState('');
  const wipe = useMutation({
    mutationFn: () => post('/settings/data/delete', { scope, password }),
    onSuccess: () => {
      toast('Données effacées.', 'success');
      setScope(null);
      setPassword('');
      qc.clear();
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader icon={<ShieldCheck className="size-4" />} title="Ce qui est stocké, et comment" />
        <ul className="list-disc space-y-1.5 px-5 pb-5 pl-9 text-[13px] leading-relaxed text-slate-600">
          <li>Vos documents, offres, candidatures et messages liés à vos candidatures sont stockés dans votre base de données, cloisonnés par compte.</li>
          <li>Les clés d'API et jetons d'accès sont chiffrés (AES-256-GCM) et ne sont jamais réaffichés ni exportés. Votre mot de passe n'est conservé que sous forme d'empreinte.</li>
          <li>Les textes envoyés au modèle d'IA le sont uniquement pour produire vos analyses et vos documents. Les informations sensibles de votre profil (nationalité, date de naissance, rémunération) ne sont jamais transmises pour noter une offre.</li>
          <li>Aucun mot de passe de site tiers n'est demandé ni stocké ; l'accès à Gmail passe par l'autorisation de Google et se révoque à tout moment.</li>
        </ul>
      </Card>
      <Card>
        <CardHeader icon={<Download className="size-4" />} title="Exporter mes données" description="Un fichier JSON lisible, avec tout ce que l'application sait de vous. Les secrets n'y figurent jamais." />
        <div className="flex flex-wrap gap-2 px-5 pb-5">
          <a href="/api/settings/data/export" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-slate-800"><Download className="size-4" /> Exporter (sans les fichiers)</a>
          <a href="/api/settings/data/export?files=1" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3.5 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 ring-inset hover:bg-slate-50"><Download className="size-4" /> Exporter avec les documents (PDF, Word)</a>
        </div>
      </Card>
      <Card>
        <CardHeader icon={<Trash2 className="size-4" />} title="Effacer des données" description="Définitif. Faites un export avant, si vous souhaitez en garder une trace." />
        <div className="flex flex-wrap gap-2 px-5 pb-5">
          <Button variant="danger" onClick={() => setScope('search')}>Effacer les offres, candidatures et emails</Button>
          <Button variant="danger" onClick={() => setScope('all')}>Tout effacer (compte conservé)</Button>
        </div>
      </Card>
      <Modal
        open={scope !== null}
        onClose={() => setScope(null)}
        title={scope === 'all' ? 'Tout effacer' : 'Effacer les offres, candidatures et emails'}
        footer={<><Button variant="ghost" onClick={() => setScope(null)}>Annuler</Button><Button variant="danger" loading={wipe.isPending} disabled={!password} onClick={() => wipe.mutate()}>Effacer définitivement</Button></>}
      >
        <div className="space-y-3">
          <Alert tone="warning">{scope === 'all' ? "Votre CV master, vos informations, votre prompt ATS, vos templates, vos offres, vos candidatures et vos réglages seront effacés. Seul votre compte est conservé." : 'Vos offres, candidatures, documents de candidature, emails rattachés et historique de recherche seront effacés. Votre profil est conservé.'}</Alert>
          <Field label="Confirmez avec votre mot de passe"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        </div>
      </Modal>
    </div>
  );
}
