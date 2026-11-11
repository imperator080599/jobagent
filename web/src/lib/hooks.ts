import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SettingKey, SettingValue } from '../../../src/shared/settings';
import { useToast } from '../components/ui';
import { ApiError, del, get, put } from './api';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'user';
  timezone: string;
  totpEnabled: boolean;
}

export interface AuthStatus {
  needsSetup: boolean;
  setupTokenRequired: boolean;
  user: SessionUser | null;
  demo: boolean;
}

export function useAuthStatus() {
  return useQuery({ queryKey: ['auth-status'], queryFn: () => get<AuthStatus>('/auth/status'), staleTime: 60_000 });
}

export interface SettingsPayload {
  settings: { [K in SettingKey]: SettingValue<K> };
  secrets: Record<string, { hint: string; updatedAt: string }>;
  env: { llmProvider: string; anthropicKeyFromEnv: boolean; serverless: boolean };
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsPayload>('/settings') });
}

/** Lecture/écriture d'un paramètre, avec retour visuel. */
export function useSetting<K extends SettingKey>(key: K) {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useSettings();
  const mutation = useMutation({
    mutationFn: (value: Partial<SettingValue<K>> | SettingValue<K>) => put(`/settings/${key}`, { value }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      toast('Enregistré', 'success');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  return { value: settings.data?.settings[key] as SettingValue<K> | undefined, save: mutation.mutate, saving: mutation.isPending, loading: settings.isLoading };
}

export function useSecret(key: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useSettings();
  const save = useMutation({
    mutationFn: (value: string) => put(`/settings/secrets/${key}`, { value }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      toast('Secret enregistré (chiffré)', 'success');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  const remove = useMutation({
    mutationFn: () => del(`/settings/secrets/${key}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      toast('Secret supprimé');
    },
    onError: (e) => toast(errorText(e), 'danger'),
  });
  return { configured: settings.data?.secrets[key], save, remove };
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Une erreur est survenue.';
}

/** État local synchronisé sur une valeur serveur (formulaires éditables). */
export function useDraft<T>(server: T | undefined): [T | undefined, (v: T) => void, boolean] {
  const [draft, setDraft] = useState<T | undefined>(server);
  const [dirty, setDirty] = useState(false);
  const key = JSON.stringify(server);
  useEffect(() => {
    setDraft(server);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [
    draft,
    (v: T) => {
      setDraft(v);
      setDirty(true);
    },
    dirty,
  ];
}

/** Raccourcis clavier globaux, inactifs pendant la saisie dans un champ. */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const fn = map[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
}
