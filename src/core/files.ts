// Stockage documentaire en base (bytea) : les documents sont petits (CV, lettres,
// captures) et bénéficient ainsi des mêmes sauvegardes et transactions que le reste.
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { sha256 } from './crypto.js';

export interface SaveFileInput {
  userId: string;
  kind: string;
  filename: string;
  mime: string;
  data: Uint8Array;
  refType?: string;
  refId?: string;
}

export async function saveFile(db: Db, f: SaveFileInput): Promise<string> {
  const id = newId('fil');
  await db.insert(files).values({
    id,
    userId: f.userId,
    kind: f.kind,
    filename: f.filename,
    mime: f.mime,
    size: f.data.byteLength,
    sha256: sha256(f.data),
    data: f.data,
    refType: f.refType ?? '',
    refId: f.refId ?? '',
  });
  return id;
}

export async function getFile(db: Db, userId: string, id: string) {
  const [row] = await db.select().from(files).where(and(eq(files.id, id), eq(files.userId, userId)));
  if (!row) return null;
  return { ...row, data: row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data as ArrayBufferLike) };
}

export async function getFileMeta(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({ id: files.id, kind: files.kind, filename: files.filename, mime: files.mime, size: files.size, sha256: files.sha256, createdAt: files.createdAt })
    .from(files)
    .where(and(eq(files.id, id), eq(files.userId, userId)));
  return row ?? null;
}

export async function deleteFile(db: Db, userId: string, id: string) {
  await db.delete(files).where(and(eq(files.id, id), eq(files.userId, userId)));
}
