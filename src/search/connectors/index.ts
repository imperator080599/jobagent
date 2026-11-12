// Registre des connecteurs disponibles.
import { ashby, greenhouse, lever, smartrecruiters } from './ats.js';
import { adzuna, feed, francetravail } from './engines.js';
import type { Connector } from './types.js';

export const CONNECTORS: Connector[] = [greenhouse, lever, ashby, smartrecruiters, francetravail, adzuna, feed];
const BY_TYPE = new Map(CONNECTORS.map((c) => [c.type, c]));

export function getConnector(type: string): Connector | null {
  return BY_TYPE.get(type) ?? null;
}

/** Reconnaît la plateforme d'un site carrières à partir de son adresse. */
export function detectConnector(rawUrl: string): { connector: Connector; config: Record<string, unknown>; name: string } | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`);
  } catch {
    return null;
  }
  for (const connector of CONNECTORS) {
    const hit = connector.detect?.(url);
    if (hit) return { connector, ...hit };
  }
  if (/\.(rss|xml|atom)(\?|$)/i.test(url.pathname + url.search) || /\/(feed|rss)\/?$/i.test(url.pathname)) return { connector: feed, config: { url: url.toString(), company: '' }, name: url.hostname.replace(/^www\./, '') };
  return null;
}

export type { Connector } from './types.js';
