import { ORPCError } from '@orpc/server';
import type { telegramRoutes } from '@saasflare-dev/db';
import { requireCaseAccess } from './case-access';
import { lookupCase } from './case-lookup';
import type { Context } from './context';
import { createReport } from './reports';
import { telegramAudit } from './telegram-adapter';
import type { TelegramUpdate } from './telegram-contract';
import { reportStatusKeyboard } from './telegram-contract';
import { queueTelegramMessage } from './telegram-outbound';
import { reportRoutePrincipal } from './telegram-report-principal';

async function queueStatusPrompt(
  context: Context,
  route: typeof telegramRoutes.$inferSelect,
  id: string,
) {
  const report = await context.env.DB.prepare(
    "SELECT r.callback_token,c.code,c.customer_name FROM reports r JOIN cases c ON c.id=r.case_id WHERE r.id=? AND r.workflow_status='awaiting_status'",
  )
    .bind(id)
    .first<{ callback_token: string; code: string; customer_name: string }>();
  if (!report) return;
  await queueTelegramMessage(
    context,
    route,
    `report-status-prompt:${id}`,
    `已收到回報\n案件：${report.customer_name} / ${report.code}\n請選擇案件狀態`,
    id,
    {
      commandReply: true,
      replyMarkup: reportStatusKeyboard(report.callback_token),
    },
  );
}
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
    'SELECT r.id,r.case_id,r.workflow_status,c.code,c.customer_name FROM telegram_updates t JOIN reports r ON r.id=t.report_id JOIN cases c ON c.id=r.case_id WHERE t.id=? AND r.origin_key=?',
  )
    .bind(updateId, `telegram-update:${updateId}`)
    .first<{
      id: string;
      case_id: string;
      workflow_status: string;
      code: string;
      customer_name: string;
    }>();
  if (committed) {
    if (committed.workflow_status === 'completed')
      return { code: 'REPORT_ALREADY_COMPLETED', reportId: committed.id };
    try {
      await requireCaseAccess(
        await reportRoutePrincipal(base, route, update),
        committed.case_id,
        'report.create',
      );
    } catch {
      return { code: 'CASE_DENIED', reportId: null };
    }
    await queueStatusPrompt(base, route, committed.id);
    return { code: 'REPORT_PENDING', reportId: committed.id };
  }
  const command = parseReportCommand(m?.text ?? '');
  if (!command) {
    await reply('請使用 /回報 代號或案件編號 回報內容（最多 3500 字）。');
    return { code: 'INVALID_COMMAND', reportId: null };
  }
  let context: Context;
  try {
    context = await reportRoutePrincipal(base, route, update);
  } catch {
    await telegramAudit(base, 'telegram.report_rejected', updateId, {
      routeId: route.id,
    }).run();
    await reply('無法接受回報，請聯絡管理員確認群組與案件授權。');
    return { code: 'ROUTE_DENIED', reportId: null };
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
    await telegramAudit(context, 'telegram.report_rejected', updateId, {
      code: 'CASE_DENIED',
      routeId: route.id,
    }).run();
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
      { telegramUserId: `route:${route.id}`, routeId: route.id },
    );
  } catch (error: unknown) {
    if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
      await reply('案件授權已變更，請聯絡管理員。');
      return { code: 'CASE_DENIED', reportId: null };
    }
    throw error;
  }
  // Business forwarding waits for an authenticated manual status selection.
  await queueStatusPrompt(context, route, report.id);
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
  return { code: 'REPORT_PENDING', reportId: report.id };
}
