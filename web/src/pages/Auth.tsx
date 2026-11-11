import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Alert, Button, Field, Input } from '../components/ui';
import { post } from '../lib/api';
import { type AuthStatus, errorText } from '../lib/hooks';

function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-9" />
          <span className="text-lg font-semibold tracking-tight text-slate-900">JobAgent</span>
        </div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        <p className="mt-1 mb-6 text-sm text-slate-500">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export function SetupPage({ status }: { status: AuthStatus }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: '', setupToken: '' });
  const m = useMutation({
    mutationFn: () => post('/auth/setup', { ...form, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth-status'] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <AuthLayout title="Créer votre compte" subtitle="Première ouverture : ce compte sera le propriétaire de cette instance.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nom">
          <Input autoFocus autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Mot de passe" hint="12 caractères minimum. Une phrase de passe est idéale.">
          <Input type="password" required minLength={12} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {status.setupTokenRequired && (
          <Field label="Jeton d'installation" hint="Valeur de la variable SETUP_TOKEN définie lors du déploiement.">
            <Input required value={form.setupToken} onChange={(e) => setForm({ ...form, setupToken: e.target.value })} />
          </Field>
        )}
        {m.isError && <Alert tone="danger">{errorText(m.error)}</Alert>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={m.isPending}>
          Créer le compte
        </Button>
        <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-500">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          Vos données restent dans votre base. Les secrets (clé d'API, messagerie) sont chiffrés avant d'être enregistrés.
        </p>
      </form>
    </AuthLayout>
  );
}

export function LoginPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: '', password: '', totp: '' });
  const [needTotp, setNeedTotp] = useState(false);
  const m = useMutation({
    mutationFn: () => post<{ totpRequired?: boolean }>('/auth/login', { email: form.email, password: form.password, totp: needTotp ? form.totp : undefined }),
    onSuccess: (res) => {
      if (res.totpRequired) setNeedTotp(true);
      else void qc.invalidateQueries();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <AuthLayout title="Connexion" subtitle="Accédez à votre centre de pilotage.">
      <form onSubmit={submit} className="space-y-4">
        {!needTotp ? (
          <>
            <Field label="Email">
              <Input type="email" required autoFocus autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Mot de passe">
              <Input type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
          </>
        ) : (
          <Field label="Code de vérification" hint="Code à 6 chiffres de votre application d'authentification, ou un code de secours.">
            <Input required autoFocus inputMode="numeric" autoComplete="one-time-code" value={form.totp} onChange={(e) => setForm({ ...form, totp: e.target.value })} />
          </Field>
        )}
        {m.isError && <Alert tone="danger">{errorText(m.error)}</Alert>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={m.isPending}>
          {needTotp ? 'Vérifier' : 'Se connecter'}
        </Button>
      </form>
    </AuthLayout>
  );
}
