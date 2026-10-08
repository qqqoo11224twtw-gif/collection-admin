import { ORPCError } from '@orpc/server';
import type { telegramRoutes } from '@saasflare-dev/db';
import { collectors, telegramIdentities } from '@saasflare-dev/db';
import { and, eq } from 'drizzle-orm';
import { requireCaseAccess } from './case-access';
import { lookupCase } from './case-lookup';
import type { Context } from './context';
import { createReport } from './reports';
import { telegramAudit } from './telegram-adapter';
import type { TelegramUpdate } from './telegram-contract';
import {
  queueReportDestination,
  queueTelegramMessage,
} from './telegram-outbound';
import { telegramPrincipal } from './telegram-principal';
export function parseReportCommand(text: string) {
  const match = /^\/回報(?:@[A-Za-z0-9_]+)?\s+(\S{1,120})\s+([\s\S]+)$/.exec(
    text.trim(),
  );
  if (!match || match[2].trim().length > 3500) return null;
  return { identifier: match[1], content: match[2].trim() };
}
export async function processReportCommand(
  base: Context,
  update: TelegramUpdate,
  route: typeof telegramRoutes.$inferSelect,
) {
  const m = update.message;
  const updateId = String(update.update_id);
  const reply = (text: string) =>
    queueTelegramMessage(base, route, `command-reply:${updateId}`, text);
  const committed = await base.env.DB.prepare(
    'SELECT r.id,c.code,c.customer_name FROM telegram_updates t JOIN reports r ON r.id=t.report_id JOIN cases c ON c.id=r.case_id WHERE t.id=? AND r.origin_key=?',
  )
    .bind(updateId, `telegram-update:${updateId}`)
    .first<{ id: string; code: string; customer_name: string }>();
  if (committed) {
    await queueReportDestination(base, committed.id);
    await reply(
      `已收到回報\n案件：${committed.customer_name} / ${committed.code}\n狀態：待分類`,
    );
    await telegramAudit(
      base,
      'telegram.report_created',
      updateId,
      { reportId: committed.id },
      {
        sql: "NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='telegram.report_created')",
        values: [updateId],
      },
    ).run();
    return { code: 'REPORT_CREATED', reportId: committed.id };
  }
  const command = parseReportCommand(m?.text ?? '');
  if (!command) {
    await reply('請使用 /回報 代號或案件編號 回報內容（最多 3500 字）。');
    return { code: 'INVALID_COMMAND', reportId: null };
  }
  const [identity] = await base.DB.select()
    .from(telegramIdentities)
    .where(
      and(
        eq(telegramIdentities.telegramUserId, String(m?.from?.id ?? '')),
        eq(telegramIdentities.isActive, true),
      ),
    )
    .limit(1);
  const [collector] = identity?.collectorId
    ? await base.DB.select()
        .from(collectors)
        .where(
          and(
            eq(collectors.id, identity.collectorId),
            eq(collectors.isActive, true),
          ),
        )
        .limit(1)
    : [];
  if (
    !collector?.userId ||
    !identity ||
    (identity.userId && identity.userId !== collector.userId) ||
    route.collectorId !== collector.id ||
    m?.sender_chat ||
    m?.from?.is_bot
  ) {
    await telegramAudit(base, 'telegram.identity_denied', updateId, {
      routeId: route.id,
    }).run();
    await reply('無法接受回報，請聯絡管理員確認身份與授權。');
    return { code: 'IDENTITY_DENIED', reportId: null };
  }
  let context: Context;
  try {
    context = await telegramPrincipal(base, collector.userId, true);
  } catch {
    await telegramAudit(base, 'telegram.identity_denied', updateId).run();
    await reply('無法接受回報，請聯絡管理員確認身份與授權。');
    return { code: 'IDENTITY_DENIED', reportId: null };
  }
  let lookup = await lookupCase(context, {
    field: 'case_no',
    value: command.identifier,
  });
  if (lookup.kind === 'not_found')
    lookup = await lookupCase(context, {
      field: 'code',
      value: command.identifier,
    });
  if (lookup.kind === 'not_found')
    lookup = await lookupCase(context, {
      field: 'customer_name',
      value: command.identifier,
    });
  if (lookup.kind === 'not_found') {
    await reply('找不到目前指派給您的案件，請使用代號或案件編號。');
    return { code: 'CASE_DENIED', reportId: null };
  }
  if (lookup.kind === 'ambiguous') {
    await telegramAudit(context, 'telegram.report_lookup_ambiguous', updateId, {
      count: lookup.candidates.length,
    }).run();
    await reply(
      `找到多筆案件，請改用代號或案件編號：\n${lookup.candidates
        .slice(0, 8)
        .map((c, i) => `${i + 1}. ${c.customerName} / ${c.code} / ${c.caseNo}`)
        .join('\n')}`,
    );
    return { code: 'AMBIGUOUS', reportId: null };
  }
  const candidate = lookup.candidates[0];
  const record = await requireCaseAccess(context, candidate.id);
  let report: { id: string };
  try {
    report = await createReport(
      context,
      {
        caseId: record.id,
        expectedCaseVersion: record.version,
        content: command.content,
        status: 'needs_review',
        revisitStatus: null,
        revisitReason: null,
        paymentDetected: false,
        paymentAmount: null,
      },
      'telegram',
      `telegram-update:${updateId}`,
    );
  } catch (error: unknown) {
    if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
      await reply('案件授權已變更，請聯絡管理員。');
      return { code: 'CASE_DENIED', reportId: null };
    }
    throw error;
  }
  // The report transaction has committed. A retry repairs missing jobs without creating a second report.
  await queueReportDestination(context, report.id);
  await reply(
    `已收到回報\n案件：${candidate.customerName} / ${candidate.code}\n狀態：待分類`,
  );
  await telegramAudit(
    context,
    'telegram.report_created',
    updateId,
    { reportId: report.id },
    {
      sql: "NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='telegram.report_created')",
      values: [updateId],
    },
  ).run();
  return { code: 'REPORT_CREATED', reportId: report.id };
}
