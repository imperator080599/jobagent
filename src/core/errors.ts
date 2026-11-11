export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentification requise.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Accès refusé.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Introuvable.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);
export const tooMany = (message = 'Trop de tentatives. Réessayez dans quelques minutes.') => new HttpError(429, 'rate_limited', message);

/** Erreur métier signalant qu'une intervention humaine est nécessaire (pas de réessai automatique). */
export class NeedsHumanError extends Error {
  constructor(
    message: string,
    public reason: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Erreur de configuration (clé d'API absente, source non configurée…) : inutile de réessayer tant que rien ne change. */
export class ConfigError extends Error {
  constructor(
    message: string,
    public what: string,
  ) {
    super(message);
  }
}
