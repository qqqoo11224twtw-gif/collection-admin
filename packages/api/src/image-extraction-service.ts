import { ORPCError } from '@orpc/server';
import { aiImageJobs, intakeMedia } from '@saasflare-dev/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { atomicCaseWrite } from './audit';
import { sha256 } from './case-media-management';
import { privateCaseStorage } from './case-storage';
import type { Context } from './context';
import {
  extractionOutputSchema,
  intakeProposalSchema,
  intakeReceiveSchema,
} from './intake-contract';
import { processIntake, resolveIntake } from './intake-resolver';
import { intakeAudit, intakeMatching, requireIntake } from './intake-service';
import {
  type ExtractionRuntime,
  emptyUsage,
  extractionOptions,
  ImageExtractionFailure,
  type OpenAISettings,
  usageSchema,
} from './openai-image-extraction';
import { requirePermission } from './permissions';
import { systemLog } from './system-log';
import { backoff } from './telegram-contract';
import { telegramPrincipal } from './telegram-principal';

const cachedSchema = z
  .object({
    output: extractionOutputSchema,
    usage: usageSchema,
    durationMs: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
  })
  .strict();
export async function intakeCollecting(context: Context, id: string) {
  return !!(await context.env.DB.prepare(
    "SELECT id FROM telegram_albums WHERE intake_id=? AND finalized_at IS NULL UNION ALL SELECT id FROM telegram_updates WHERE intake_id=? AND status<>'done' LIMIT 1",
  )
    .bind(id, id)
    .first());
}
export async function enqueueImageExtraction(
  context: Context,
  id: string,
  provider: ExtractionRuntime,
) {
  requirePermission(context, 'intake.resolve');
  requirePermission(context, 'media.view');
  const row = await requireIntake(context, id);
  if (row.source !== 'telegram')
    throw new ORPCError('FORBIDDEN', {
      message: '圖片辨識僅限 Telegram 新案件收件。',
    });
  if (
    !['received', 'processing'].includes(row.status) ||
    (await intakeCollecting(context, id))
  )
    throw new ORPCError('CONFLICT');
  const media = await context.DB.select()
    .from(intakeMedia)
    .where(eq(intakeMedia.intakeId, id));
  if (!media.length) throw new ORPCError('BAD_REQUEST');
  const statements: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const m of media) {
    if (seen.has(m.sha256)) continue;
    seen.add(m.sha256);
    const jobId = crypto.randomUUID();
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO ai_image_jobs(id,intake_id,media_id,sha256,provider,model,provider_version,status,attempts,next_attempt_at,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?,?) ON CONFLICT(intake_id,sha256,provider,model,provider_version) DO NOTHING",
      ).bind(
        jobId,
        id,
        m.id,
        m.sha256,
        provider.provider,
        provider.model,
        provider.version,
        now,
        context.user?.id,
        now,
        now,
      ),
      context.env.DB.prepare(
        "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'image_extraction.queued','intake',?,?,? WHERE EXISTS(SELECT 1 FROM ai_image_jobs WHERE id=?)",
      ).bind(
        crypto.randomUUID(),
        context.user?.id,
        id,
        JSON.stringify({ entityId: jobId }),
        now,
        jobId,
      ),
    );
  }
  await context.env.DB.batch(statements);
  return { id, count: seen.size };
}
function usageStatement(
  context: Context,
  job: typeof aiImageJobs.$inferSelect,
  attempt: number,
  usage: z.infer<typeof usageSchema>,
  duration: number,
  success: boolean,
  errorCode: string | null,
) {
  return context.env.DB.prepare(
    "INSERT INTO ai_usage_logs(id,job_id,provider,model,task_type,input_tokens,output_tokens,duration_ms,success,error_code,created_at) VALUES(?,?,?,?,'image_extraction',?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  ).bind(
    `${job.id}:${attempt}`,
    job.id,
    job.provider,
    job.model,
    usage.inputTokens,
    usage.outputTokens,
    duration,
    Number(success),
    errorCode,
    Date.now(),
  );
}
export async function processImageExtractionJobs(
  base: Context,
  provider: ExtractionRuntime,
  now = Date.now(),
) {
  const settings: OpenAISettings = base.env;
  const { maxAttempts } = extractionOptions(settings);
  await base.env.DB.prepare(
    "UPDATE ai_image_jobs SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,error_code='AI_LEASE_EXPIRED',lease_token=NULL,lease_until=NULL WHERE status='processing' AND lease_until<=?",
  )
    .bind(maxAttempts, now)
    .run();
  const pending = await base.DB.select()
    .from(aiImageJobs)
    .where(
      and(
        eq(aiImageJobs.status, 'pending'),
        eq(aiImageJobs.provider, provider.provider),
        eq(aiImageJobs.model, provider.model),
        eq(aiImageJobs.providerVersion, provider.version),
        sql`${aiImageJobs.nextAttemptAt}<=${now}`,
        sql`EXISTS(SELECT 1 FROM intake_items i WHERE i.id=${aiImageJobs.intakeId} AND i.source='telegram')`,
      ),
    )
    .limit(10);
  for (const selected of pending) {
    const token = crypto.randomUUID();
    const claim = await base.env.DB.prepare(
      "UPDATE ai_image_jobs SET status='processing',attempts=attempts+1,lease_until=?,lease_token=?,updated_at=? WHERE id=? AND status='pending' AND next_attempt_at<=?",
    )
      .bind(Math.max(now, Date.now()) + 120000, token, now, selected.id, now)
      .run();
    if (claim.meta.changes !== 1) continue;
    const [job] = await base.DB.select()
      .from(aiImageJobs)
      .where(eq(aiImageJobs.id, selected.id));
    const start = Date.now();
    let usage = emptyUsage;
    let requested = false;
    let cached: z.infer<typeof cachedSchema> | undefined;
    const cacheKey = `image-extraction:${await sha256(new TextEncoder().encode(`${job.intakeId}:${job.sha256}:${job.provider}:${job.model}:${job.providerVersion}`).buffer)}`;
    try {
      const context = await telegramPrincipal(base, job.createdByUserId);
      requirePermission(context, 'intake.resolve');
      requirePermission(context, 'media.view');
      const intake = await requireIntake(context, job.intakeId);
      if (!['received', 'processing'].includes(intake.status))
        throw new ImageExtractionFailure('INTAKE_NOT_DRAFT', false);
      if (await intakeCollecting(context, intake.id))
        throw new ImageExtractionFailure('INTAKE_COLLECTING', true);
      cached = cachedSchema.safeParse(
        await base.env.KV.get(cacheKey, 'json'),
      ).data;
      if (!cached) {
        const [media] = await base.DB.select()
          .from(intakeMedia)
          .where(eq(intakeMedia.id, job.mediaId));
        const bytes = media
          ? await privateCaseStorage(base.env).read(media.storageKey)
          : null;
        if (!bytes || (await sha256(bytes)) !== job.sha256)
          throw new ImageExtractionFailure('PRIVATE_IMAGE_UNAVAILABLE', false);
        requested = true;
        const attempt = await provider.run({
          mediaId: job.mediaId,
          image: { bytes, mediaType: media.mediaType },
        });
        usage = usageSchema.parse(attempt.usage);
        const result = extractionOutputSchema.safeParse(attempt.output);
        if (!result.success)
          throw new ImageExtractionFailure('AI_INVALID_OUTPUT', false, usage);
        cached = {
          output: result.data,
          usage,
          durationMs: Math.max(0, Date.now() - start),
          attempt: job.attempts,
        };
        // Persist only validated fields and usage before D1 application. No image bytes or prompts.
        await base.env.KV.put(cacheKey, JSON.stringify(cached));
      }
      await base.env.DB.batch([
        base.env.DB.prepare(
          "UPDATE ai_image_jobs SET status='succeeded',result=?,error_code=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='processing'",
        ).bind(JSON.stringify(cached.output), now, job.id, token),
        usageStatement(
          base,
          job,
          cached.attempt,
          cached.usage,
          cached.durationMs,
          true,
          null,
        ),
      ]);
      await systemLog(base.env.DB, {
        category: 'openai',
        event: 'IMAGE_EXTRACTION_SUCCEEDED',
        safeMessage: 'Telegram 新案件圖片辨識完成。',
        relatedJobId: job.id,
        relatedUserId: job.createdByUserId,
        durationMs: cached.durationMs,
        retryCount: job.attempts,
      });
    } catch (error: unknown) {
      const failure =
        error instanceof ImageExtractionFailure
          ? error
          : new ImageExtractionFailure(
              error instanceof ORPCError
                ? 'AI_PERMISSION_DENIED'
                : 'AI_PROCESSING_RETRY',
              !(error instanceof ORPCError),
              usage,
            );
      const retry = failure.retryable && job.attempts < maxAttempts;
      const duration = Math.max(0, Date.now() - start);
      await systemLog(base.env.DB, {
        category: 'openai',
        event: retry ? 'IMAGE_EXTRACTION_RETRY' : 'IMAGE_EXTRACTION_FAILED',
        safeMessage:
          'Telegram 新案件圖片辨識失敗，請確認辨識設定或進入待確認中心。',
        level: retry ? 'warning' : 'error',
        status: retry ? 'retry' : 'failed',
        errorCode: failure.code,
        relatedJobId: job.id,
        relatedUserId: job.createdByUserId,
        durationMs: duration,
        retryCount: job.attempts,
      });
      await base.env.DB.batch([
        base.env.DB.prepare(
          "UPDATE ai_image_jobs SET status=?,error_code=?,next_attempt_at=?,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='processing'",
        ).bind(
          retry ? 'pending' : 'failed',
          failure.code,
          now + Math.max(backoff(job.attempts), failure.retryAfterMs),
          now,
          job.id,
          token,
        ),
        ...(cached
          ? [
              usageStatement(
                base,
                job,
                cached.attempt,
                cached.usage,
                cached.durationMs,
                true,
                null,
              ),
            ]
          : requested
            ? [
                usageStatement(
                  base,
                  job,
                  job.attempts,
                  failure.usage,
                  duration,
                  false,
                  failure.code,
                ),
              ]
            : []),
        base.env.DB.prepare(
          "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,'intake',?,?,? WHERE EXISTS(SELECT 1 FROM ai_image_jobs WHERE id=? AND lease_token=? AND status=?)",
        ).bind(
          crypto.randomUUID(),
          job.createdByUserId,
          retry ? 'image_extraction.retry' : 'image_extraction.failed',
          job.intakeId,
          JSON.stringify({
            entityId: job.id,
            attempt: job.attempts,
            code: failure.code,
          }),
          now,
          job.id,
          token,
          retry ? 'pending' : 'failed',
        ),
      ]);
    }
  }
  const ready = await base.env.DB.prepare(
    "SELECT DISTINCT j.intake_id,j.created_by_user_id FROM ai_image_jobs j JOIN intake_items i ON i.id=j.intake_id WHERE j.provider=? AND j.model=? AND j.provider_version=? AND i.source='telegram' AND i.status IN ('received','processing') LIMIT 20",
  )
    .bind(provider.provider, provider.model, provider.version)
    .all<{ intake_id: string; created_by_user_id: string }>();
  for (const draft of ready.results) {
    try {
      await applyExtraction(
        await telegramPrincipal(base, draft.created_by_user_id),
        draft.intake_id,
        provider,
      );
    } catch {
      /* Validated cached results remain available for domain-resolution retry. */
    }
  }
}
export async function applyExtraction(
  context: Context,
  id: string,
  provider: ExtractionRuntime,
) {
  requirePermission(context, 'intake.resolve');
  const row = await requireIntake(context, id);
  if (
    !['received', 'processing'].includes(row.status) ||
    (await intakeCollecting(context, id))
  )
    return;
  const media = await context.DB.select({ sha: intakeMedia.sha256 })
    .from(intakeMedia)
    .where(eq(intakeMedia.intakeId, id));
  const hashes = [...new Set(media.map((m) => m.sha))].sort();
  if (!hashes.length) return;
  const jobs = await context.DB.select()
    .from(aiImageJobs)
    .where(
      and(
        eq(aiImageJobs.intakeId, id),
        eq(aiImageJobs.provider, provider.provider),
        eq(aiImageJobs.model, provider.model),
        eq(aiImageJobs.providerVersion, provider.version),
      ),
    );
  const selected = hashes.map((hash) => jobs.find((j) => j.sha256 === hash));
  if (selected.some((j) => !j || !['succeeded', 'failed'].includes(j.status)))
    return;
  const key = await sha256(
    new TextEncoder().encode(
      `${provider.provider}:${provider.model}:${provider.version}:${hashes.join(':')}`,
    ).buffer,
  );
  if (row.extractionKey === key && row.status === 'processing') return;
  let version = row.version;
  if (row.extractionKey !== key) {
    const outputs = selected.map((j) =>
      j?.status === 'succeeded' && j.result
        ? extractionOutputSchema.parse(JSON.parse(j.result))
        : {
            code: null,
            customer_name: null,
            address: null,
            amount_due: null,
            confidence: 0,
          },
    );
    const values = <T>(list: (T | null)[]) => {
      const distinct = [...new Set(list.filter((v): v is T => v !== null))];
      return distinct.length === 1 ? distinct[0] : null;
    };
    const proposal = intakeProposalSchema.parse({
      code: values(outputs.map((o) => o.code)),
      customer_name: values(outputs.map((o) => o.customer_name)),
      address: values(outputs.map((o) => o.address)),
      amount_due: values(outputs.map((o) => o.amount_due)),
    });
    let confidence = Math.min(...outputs.map((o) => o.confidence));
    if (Object.values(proposal).some((v) => v === null))
      confidence = Math.min(confidence, 0.79);
    const token = crypto.randomUUID();
    const original =
      row.receivedData ??
      JSON.stringify(
        intakeReceiveSchema.parse({
          source: row.source,
          externalId: row.externalId,
          dedupeKey: row.dedupeKey,
          proposedData: JSON.parse(row.proposedData),
          caseNo: row.caseNoHint,
          confidence: row.confidence,
        }),
      );
    await atomicCaseWrite(context, [
      context.env.DB.prepare(
        "UPDATE intake_items SET proposed_data=?,confidence=?,received_data=COALESCE(received_data,?),extraction_key=?,status='received',version=version+1,updated_at=?,write_token=? WHERE id=? AND version=? AND status IN ('received','processing') AND NOT EXISTS(SELECT 1 FROM telegram_albums a WHERE a.intake_id=intake_items.id AND a.finalized_at IS NULL) AND NOT EXISTS(SELECT 1 FROM telegram_updates t WHERE t.intake_id=intake_items.id AND t.status<>'done')",
      ).bind(
        JSON.stringify(proposal),
        confidence,
        original,
        key,
        Date.now(),
        token,
        id,
        row.version,
      ),
      intakeAudit(
        context,
        id,
        'image_extraction.applied',
        { count: hashes.length },
        token,
      ),
    ]);
    version++;
  }
  const current = await requireIntake(context, id);
  const matching = await intakeMatching(context, current);
  if ((current.confidence ?? 0) >= 0.8 && matching.kind === 'unique_match')
    await resolveIntake(context, {
      id,
      expectedVersion: version,
      action: 'match',
      caseId: matching.candidates[0].id,
    });
  else await processIntake(context, { id, expectedVersion: version });
}
