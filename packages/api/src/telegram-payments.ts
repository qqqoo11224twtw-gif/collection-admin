import { ORPCError } from '@orpc/server';
import type { telegramRoutes } from '@saasflare-dev/db';
import type { Context } from './context';
import { createPayment } from './finance';
import { businessToday, moneySchema } from './finance-contract';
import type { TelegramClient } from './telegram-client';
import type { TelegramUpdate } from './telegram-contract';
import { queueTelegramMessage } from './telegram-outbound';
import { reportRoutePrincipal } from './telegram-report-principal';
import { processReportStatusCallback } from './telegram-report-status';
export async function processTelegramPayment(
  base: Context,
  update: TelegramUpdate,
  route: typeof telegramRoutes.$inferSelect,
  client: TelegramClient,
) {
  const rows = await base.env.DB.prepare(
    "SELECT id,case_id,assignment_id,callback_token,created_at FROM reports WHERE callback_route_id=? AND workflow_status='awaiting_status' AND selected_status='settled' AND NOT EXISTS(SELECT 1 FROM telegram_report_conversations conv WHERE conv.report_id=reports.id AND (conv.stage<>'status' OR conv.expires_at<=?)) ORDER BY created_at LIMIT 2",
  )
    .bind(route.id, Date.now())
    .all<{
      id: string;
      case_id: string;
      assignment_id: string;
      callback_token: string;
      created_at: number;
    }>();
  if (!rows.results.length) return null;
  if (rows.results.length !== 1) {
    await queueTelegramMessage(
      base,
      route,
      `payment-ambiguous:${update.update_id}`,
      '有多筆待輸入收款的回報，請聯絡管理員確認。',
    );
    return { code: 'PAYMENT_AMBIGUOUS', reportId: null };
  }
  const row = rows.results[0],
    context = await reportRoutePrincipal(base, route, update);
  const assignment = await base.env.DB.prepare(
    'SELECT id FROM assignments WHERE id=? AND collector_id=? AND unassigned_at IS NULL',
  )
    .bind(row.assignment_id, route.collectorId)
    .first();
  if (!assignment) return { code: 'PAYMENT_DENIED', reportId: null };
  const text = update.message?.text?.trim() ?? '';
  const amount = /^[1-9]\d{0,8}$/.test(text) ? Number(text) : 0;
  if (!moneySchema.safeParse(amount).success) {
    await queueTelegramMessage(
      context,
      route,
      `payment-invalid:${update.update_id}`,
      '請輸入大於零的實際收款金額（整數台幣）。',
      row.id,
      { commandReply: true },
    );
    return { code: 'PAYMENT_INVALID', reportId: row.id };
  }
  try {
    await createPayment(
      context,
      {
        caseId: row.case_id,
        receivedAmount: amount,
        receivedDate: businessToday(
          new Date(row.created_at),
          base.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
        ),
        installmentScheduleId: null,
        idempotencyKey: row.id,
      },
      { reportId: row.id, assignmentId: row.assignment_id, routeId: route.id },
    );
  } catch (error) {
    if (error instanceof ORPCError && error.code === 'BAD_REQUEST') {
      await queueTelegramMessage(
        context,
        route,
        `payment-rejected:${update.update_id}`,
        error.message,
        row.id,
        { commandReply: true },
      );
      return { code: 'PAYMENT_REJECTED', reportId: row.id };
    }
    throw error;
  }
  return processReportStatusCallback(
    base,
    {
      update_id: update.update_id,
      callback_query: {
        id: `payment-${update.update_id}`,
        from: update.message?.from ?? { id: 1 },
        message: update.message,
        data: `report_status:${row.callback_token}:settled`,
      },
    },
    route,
    {
      sendMessage: client.sendMessage.bind(client),
      downloadFile: client.downloadFile.bind(client),
      answerCallbackQuery: async () => {},
    },
  );
}
