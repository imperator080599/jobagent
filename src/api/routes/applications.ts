// Candidatures : dossier prêt, validation des documents, déclaration d'envoi, liste de suivi.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { approveApplication, buildPack, recordSubmission } from '../../apply/service.js';
import { applications, jobs } from '../../db/schema.js';
import { SUBMITTED_STAGES } from '../../shared/stages.js';
import { type AppDeps, body, router } from '../http.js';
import { sessionOnly } from '../middleware.js';

export function applicationsRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  /** Candidatures envoyées ou en préparation, de la plus récente à la plus ancienne. */
  r.get('/', async (c) => {
    const userId = c.get('user').id;
    const rows = await ctx.db
      .select({
        jobId: jobs.id,
        companyName: jobs.companyName,
        title: jobs.title,
        locationRaw: jobs.locationRaw,
        stage: jobs.stage,
        stageChangedAt: jobs.stageChangedAt,
        atsScore: jobs.atsScore,
        priorityScore: jobs.priorityScore,
        deadlineAt: jobs.deadlineAt,
        applyUrl: jobs.applyUrl,
        applicationId: applications.id,
        mode: applications.mode,
        channel: applications.channel,
        submittedAt: applications.submittedAt,
        confirmedAt: applications.confirmedAt,
        followUpDueAt: applications.followUpDueAt,
        followUpCount: applications.followUpCount,
        lastActivityAt: applications.lastActivityAt,
        outcome: applications.outcome,
      })
      .from(jobs)
      .leftJoin(applications, and(eq(applications.jobId, jobs.id), eq(applications.userId, userId)))
      .where(and(eq(jobs.userId, userId), inArray(jobs.stage, ['cv_in_progress', 'letter_in_progress', 'ready_to_apply', 'applying', ...SUBMITTED_STAGES])))
      .orderBy(desc(jobs.stageChangedAt))
      .limit(500);
    return c.json({ items: rows });
  });

  /** Dossier de candidature et contrôle qualité avant envoi. */
  r.get('/:jobId', async (c) => c.json(await buildPack(c.get('uctx'), c.req.param('jobId'))));

  r.post('/:jobId/approve', sessionOnly, async (c) => {
    const input = await body(c, z.object({ withoutLetter: z.boolean().optional(), send: z.boolean().optional() }));
    return c.json(await approveApplication(c.get('uctx'), c.req.param('jobId'), input));
  });

  r.post('/:jobId/submitted', sessionOnly, async (c) => {
    const input = await body(c, z.object({ channel: z.string().max(120).optional(), appliedAt: z.string().optional(), confirmationText: z.string().max(4000).optional(), confirmationUrl: z.string().max(2000).optional(), notes: z.string().max(4000).optional() }));
    return c.json(await recordSubmission(c.get('uctx'), c.req.param('jobId'), input));
  });

  return r;
}
