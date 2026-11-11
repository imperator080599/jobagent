// Base de réponses réutilisables pour les formulaires. Une question déjà répondue
// n'est jamais reposée : elle est retrouvée même formulée différemment.
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { qaAnswers } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { normalize, tokenSimilarity } from '../core/text.js';
import { badRequest, notFound } from '../core/errors.js';

export type QaAnswer = typeof qaAnswers.$inferSelect;

export function normalizeQuestion(q: string): string {
  return normalize(q.replace(/\*+\s*$/, '').replace(/\(?\b(required|obligatoire|optional|facultatif)\b\)?/gi, ''))
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function listAnswers(db: Db, userId: string): Promise<QaAnswer[]> {
  return db.select().from(qaAnswers).where(eq(qaAnswers.userId, userId)).orderBy(desc(qaAnswers.updatedAt));
}

export interface AnswerInput {
  question: string;
  answer: string;
  answerType?: QaAnswer['answerType'];
  scope?: QaAnswer['scope'];
  scopeValue?: string;
  language?: string;
  sensitive?: boolean;
  status?: QaAnswer['status'];
  source?: QaAnswer['source'];
}

/** Crée ou met à jour la réponse à une question (même question + même portée = même ligne). */
export async function upsertAnswer(db: Db, userId: string, input: AnswerInput): Promise<QaAnswer> {
  const question = input.question.trim();
  const questionNorm = normalizeQuestion(question);
  if (!questionNorm) throw badRequest('La question est vide.');
  const scope = input.scope ?? 'general';
  const scopeValue = scope === 'general' ? '' : normalize(input.scopeValue ?? '');
  const now = new Date();
  const [row] = await db
    .insert(qaAnswers)
    .values({
      id: newId('qa'),
      userId,
      question,
      questionNorm,
      answer: input.answer,
      answerType: input.answerType ?? 'text',
      scope,
      scopeValue,
      language: input.language ?? '',
      sensitive: input.sensitive ?? false,
      status: input.status ?? 'validated',
      source: input.source ?? 'user',
    })
    .onConflictDoUpdate({
      target: [qaAnswers.userId, qaAnswers.questionNorm, qaAnswers.scope, qaAnswers.scopeValue],
      set: { answer: input.answer, status: input.status ?? 'validated', answerType: input.answerType ?? 'text', sensitive: input.sensitive ?? false, updatedAt: now },
    })
    .returning();
  return row!;
}

export async function updateAnswer(db: Db, userId: string, id: string, patch: Partial<Pick<QaAnswer, 'answer' | 'status' | 'sensitive' | 'answerType'>>): Promise<QaAnswer> {
  const [row] = await db
    .update(qaAnswers)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(qaAnswers.id, id), eq(qaAnswers.userId, userId)))
    .returning();
  if (!row) throw notFound('Réponse introuvable.');
  return row;
}

export async function deleteAnswer(db: Db, userId: string, id: string): Promise<void> {
  await db.delete(qaAnswers).where(and(eq(qaAnswers.id, id), eq(qaAnswers.userId, userId)));
}

export interface AnswerMatch {
  answer: QaAnswer;
  /** 1 = question identique ; entre le seuil et 1 = formulation proche. */
  confidence: number;
}

const SCOPE_RANK: Record<QaAnswer['scope'], number> = { job: 3, company: 2, country: 1, general: 0 };

/**
 * Retrouve la réponse validée à une question de formulaire. La portée la plus
 * précise l'emporte (offre > entreprise > pays > général). En dessous du seuil de
 * similarité, on ne répond pas : la question sera posée à l'utilisateur.
 */
export async function findAnswer(db: Db, userId: string, question: string, where: { jobId?: string; company?: string; country?: string } = {}, threshold = 0.8): Promise<AnswerMatch | null> {
  const norm = normalizeQuestion(question);
  if (!norm) return null;
  const rows = await db.select().from(qaAnswers).where(and(eq(qaAnswers.userId, userId), eq(qaAnswers.status, 'validated')));
  const applies = (a: QaAnswer) =>
    a.scope === 'general' ||
    (a.scope === 'job' && a.scopeValue === normalize(where.jobId ?? '')) ||
    (a.scope === 'company' && !!where.company && a.scopeValue === normalize(where.company)) ||
    (a.scope === 'country' && !!where.country && a.scopeValue === normalize(where.country));
  let best: AnswerMatch | null = null;
  for (const a of rows) {
    if (!applies(a)) continue;
    const candidates = [a.questionNorm, ...a.variants.map(normalizeQuestion)];
    const confidence = candidates.includes(norm) ? 1 : Math.max(...candidates.map((c) => tokenSimilarity(c, norm)));
    if (confidence < threshold) continue;
    if (!best || confidence > best.confidence + 0.001 || (Math.abs(confidence - best.confidence) <= 0.001 && SCOPE_RANK[a.scope] > SCOPE_RANK[best.answer.scope])) best = { answer: a, confidence };
  }
  return best;
}

/** Mémorise une nouvelle formulation de la question et compte l'utilisation. */
export async function recordAnswerUse(db: Db, answer: QaAnswer, askedAs: string): Promise<void> {
  const variants = answer.variants.includes(askedAs) || normalizeQuestion(askedAs) === answer.questionNorm ? answer.variants : [...answer.variants, askedAs].slice(-20);
  await db.update(qaAnswers).set({ variants, usageCount: sql`${qaAnswers.usageCount} + 1`, lastUsedAt: new Date() }).where(eq(qaAnswers.id, answer.id));
}
