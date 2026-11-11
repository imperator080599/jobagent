// Client HTTP de l'interface. Toutes les requêtes modifiantes portent l'en-tête
// anti-CSRF attendu par le serveur ; les erreurs sont normalisées.
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal };

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-jobagent-client': 'web' };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin', signal: opts.signal });
  } catch {
    throw new ApiError(0, 'network', 'Serveur injoignable. Vérifiez votre connexion.');
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const e = data?.error;
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('jobagent:unauthorized'));
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Erreur ${res.status}`, e?.details);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const put = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body: body ?? {} });
export const patch = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body: body ?? {} });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });
export const upload = <T = any>(path: string, form: FormData) => api<T>(path, { method: 'POST', form });
