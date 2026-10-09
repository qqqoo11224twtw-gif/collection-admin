import { ORPCError } from '@orpc/server';
import { installmentWorkflows, type telegramRoutes } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { atomicCaseWrite } from './audit';
import { requireCaseAccess } from './case-access';
import type { Context } from './context';
import { financeAudit } from './finance-audit';
import {
  businessToday,
  dateSchema,
  generateSchedule,
  moneySchema,
  planCreateSchema,
} from './finance-contract';
import { INSTALLMENT_SCOPE_SQL } from './installment-scope';
import { createInstallmentPlan } from './installments';
import type { TelegramClient } from './telegram-client';
import {
  type InlineKeyboard,
  inlineKeyboardSchema,
  type TelegramUpdate,
} from './telegram-contract';
import { queueTelegramMessage } from './telegram-outbound';
import { reportRoutePrincipal } from './telegram-report-principal';

const dataSchema = z
  .object({
    planType: z.enum(['deadline', 'weekly', 'monthly']).optional(),
    deadlineDate: dateSchema.optional(),
    weekday: z.number().int().min(1).max(7).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    perPaymentAmount: moneySchema.optional(),
    totalAmount: moneySchema.optional(),
  })
  .strict();
type Workflow = typeof installmentWorkflows.$inferSelect;
type Route = typeof telegramRoutes.$inferSelect;
const scopeSql = INSTALLMENT_SCOPE_SQL;
async function authorized(
  base: Context,
  row: Workflow,
  update: TelegramUpdate,
  route: Route,
) {
  const message = update.callback_query?.message ?? update.message;
  if (
    row.routeId !== route.id ||
    route.chatId !== String(message?.chat.id) ||
    route.topicId !== (message?.message_thread_id ?? null) ||
    route.collectorId !== row.collectorId
  )
    throw new ORPCError('FORBIDDEN');
  const valid = await base.env.DB.prepare(
    `SELECT id FROM installment_workflows WHERE id=? AND ${scopeSql}`,
  )
    .bind(row.id)
    .first();
  if (!valid) throw new ORPCError('FORBIDDEN');
  const context = await reportRoutePrincipal(base, route, update);
  await requireCaseAccess(context, row.caseId, 'installment.create');
  return context;
}
async function prompt(context: Context, row: Workflow, route: Route) {
  const record = await requireCaseAccess(
      context,
      row.caseId,
      'installment.view',
    ),
    data = dataSchema.parse(JSON.parse(row.data));
  let text = '';
  let buttons: { label: string; action: string }[][] = [];
  const cancel = { label: '取消', action: 'cancel' };
  if (row.status === 'completed')
    text = '分期計畫已建立。預計應收與實際收款會分開記錄。';
  else if (row.status !== 'active')
    text =
      row.status === 'expired'
        ? '分期設定已過期，請聯絡管理員。'
        : '已取消分期設定。';
  else
    switch (row.step) {
      case 'type':
        text = '請選擇分期方式：';
        buttons = [
          [{ label: '📅 指定日期前處理', action: 'deadline' }],
          [{ label: '🗓 每週', action: 'weekly' }],
          [{ label: '📆 每月', action: 'monthly' }],
          [cancel],
        ];
        break;
      case 'deadline':
        text = '請輸入截止日期（YYYY/MM/DD）。';
        buttons = [[cancel]];
        break;
      case 'weekday':
        text = '請選擇每週付款日：';
        buttons = Array.from({ length: 7 }, (_, index) => [
          {
            label: `星期${['一', '二', '三', '四', '五', '六', '日'][index]}`,
            action: `week${index + 1}`,
          },
        ]);
        buttons.push([cancel]);
        break;
      case 'monthday':
        text = '請選擇每月付款日期：';
        buttons = [
          [5, 10, 15].map((day) => ({
            label: `${day}號`,
            action: `day${day}`,
          })),
          [20, 25].map((day) => ({ label: `${day}號`, action: `day${day}` })),
          [{ label: '自訂', action: 'custom' }, cancel],
        ];
        break;
      case 'customday':
        text =
          '請輸入每月付款日（1 至 31）。若該月沒有該日期，使用該月最後一天。';
        buttons = [[cancel]];
        break;
      case 'per':
        text = '請輸入每次付款金額（整數台幣）。';
        buttons = [[cancel]];
        break;
      case 'total':
        text = '請輸入總共需要支付的金額（整數台幣）。';
        buttons = [[cancel]];
        break;
      case 'confirm': {
        const plan = planCreateSchema.parse({
          ...data,
          caseId: row.caseId,
          reportId: row.reportId,
        });
        const schedule = generateSchedule(
          plan,
          businessToday(
            new Date(),
            context.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
          ),
        );
        const timing =
          plan.planType === 'deadline'
            ? `處理期限：${plan.deadlineDate}`
            : plan.planType === 'weekly'
              ? `付款日：每週${['一', '二', '三', '四', '五', '六', '日'][plan.weekday - 1]}`
              : `付款日：每月${plan.dayOfMonth}號（缺日採月底）`;
        text = `分期確認\n案件：${record.customerName} / ${record.code}\n方式：${{ deadline: '指定日期前處理', weekly: '每週', monthly: '每月' }[plan.planType]}\n${timing}\n${plan.planType === 'deadline' ? '' : `每期：${plan.perPaymentAmount}\n`}總額：${plan.totalAmount}\n預計期數：${schedule.length}\n首期：${schedule[0].dueDate}`;
        buttons = [[{ label: '確認建立', action: 'confirm' }, cancel]];
        break;
      }
      default:
        throw new ORPCError('BAD_REQUEST');
    }
  // Telegram allows eight rows; keep opaque state/version tokens under 64 bytes.
  const replyMarkup: InlineKeyboard | undefined = buttons.length
    ? inlineKeyboardSchema.parse({
        inline_keyboard: buttons.map((group) =>
          group.map((button) => ({
            text: button.label,
            callback_data: `ip:${row.token}:${row.version}:${button.action}`,
          })),
        ),
      })
    : undefined;
  await queueTelegramMessage(
    context,
    route,
    `installment-prompt:${row.id}:${row.version}`,
    text,
    row.reportId,
    { commandReply: true, replyMarkup },
  );
}
export async function ensureInstallmentWorkflow(
  context: Context,
  reportId: string,
  route: Route,
) {
  const report = await context.env.DB.prepare(
    "SELECT id,case_id,assignment_id,collector_id,created_by_user_id,telegram_user_id FROM reports WHERE id=? AND workflow_status='completed' AND selected_status='installment'",
  )
    .bind(reportId)
    .first<{
      id: string;
      case_id: string;
      assignment_id: string;
      collector_id: string;
      created_by_user_id: string;
      telegram_user_id: string;
    }>();
  if (!report) return;
  const now = Date.now();
  await context.env.DB.prepare(
    "UPDATE installment_workflows SET status='expired',version=version+1,updated_at=? WHERE status='active' AND expires_at<=?",
  )
    .bind(now, now)
    .run();
  const id = crypto.randomUUID();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO installment_workflows(id,token,case_id,report_id,assignment_id,collector_id,user_id,telegram_user_id,route_id,step,data,status,expires_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,'type','{}','active',?,?,? WHERE EXISTS(SELECT 1 FROM assignments WHERE id=? AND unassigned_at IS NULL) AND NOT EXISTS(SELECT 1 FROM reports WHERE callback_route_id=? AND workflow_status='awaiting_status' AND selected_status='settled') ON CONFLICT DO NOTHING",
    ).bind(
      id,
      crypto.randomUUID().replaceAll('-', ''),
      report.case_id,
      report.id,
      report.assignment_id,
      report.collector_id,
      report.created_by_user_id,
      report.telegram_user_id,
      route.id,
      now + 24 * 60 * 60 * 1000,
      now,
      now,
      report.assignment_id,
      route.id,
    ),
    financeAudit(context, report.case_id, 'installment.workflow_started', id, {
      sql: 'EXISTS(SELECT 1 FROM installment_workflows WHERE id=?)',
      values: [id],
    }),
  ]);
  const [row] = await context.DB.select()
    .from(installmentWorkflows)
    .where(eq(installmentWorkflows.reportId, reportId));
  if (row) await prompt(context, row, route);
  else
    await queueTelegramMessage(
      context,
      route,
      `installment-busy:${reportId}`,
      '此群組有未完成的收款或分期設定，請先完成，再點選此回報的分期按鈕。',
      reportId,
      { commandReply: true },
    );
}
export async function processInstallmentUpdate(
  base: Context,
  update: TelegramUpdate,
  route: Route,
  client: TelegramClient,
) {
  const callback = update.callback_query;
  const match =
    /^ip:([a-f0-9]{32}):(\d{1,8}):(deadline|weekly|monthly|week[1-7]|day(?:5|10|15|20|25)|custom|confirm|cancel)$/.exec(
      callback?.data ?? '',
    );
  const [row] = match
    ? await base.DB.select()
        .from(installmentWorkflows)
        .where(eq(installmentWorkflows.token, match[1]))
    : await base.DB.select()
        .from(installmentWorkflows)
        .where(eq(installmentWorkflows.routeId, route.id))
        .then((rows) =>
          rows.filter((r) => r.routeId === route.id && r.status === 'active'),
        );
  const deny = async () => {
    if (callback)
      await client.answerCallbackQuery(callback.id, '分期設定無效或沒有權限。');
    return { code: 'INSTALLMENT_DENIED', reportId: null };
  };
  if (!row || (callback && !match)) return deny();
  let context: Context;
  try {
    context = await authorized(base, row, update, route);
  } catch {
    return deny();
  }
  if (row.status !== 'active') {
    if (callback)
      await client.answerCallbackQuery(
        callback.id,
        row.status === 'completed'
          ? '此分期設定已完成。'
          : '此分期設定已結束。',
      );
    return { code: 'INSTALLMENT_ALREADY_PROCESSED', reportId: row.reportId };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await base.env.DB.prepare(
      "UPDATE installment_workflows SET status='expired',version=version+1 WHERE id=? AND status='active'",
    )
      .bind(row.id)
      .run();
    return deny();
  }
  if (row.lastUpdateId === String(update.update_id)) {
    await prompt(context, row, route);
    return { code: 'INSTALLMENT_REPLAY', reportId: row.reportId };
  }
  if (match && Number(match[2]) !== row.version) {
    if (callback)
      await client.answerCallbackQuery(
        callback.id,
        '這個按鈕已過期，請使用最新訊息。',
      );
    return { code: 'INSTALLMENT_STALE', reportId: row.reportId };
  }
  const data = dataSchema.parse(JSON.parse(row.data)),
    action = match?.[3];
  let step = row.step,
    status: 'active' | 'cancelled' = 'active';
  if (action === 'cancel') status = 'cancelled';
  else if (action === 'confirm' && row.step === 'confirm') {
    try {
      await createInstallmentPlan(
        context,
        planCreateSchema.parse({
          ...data,
          caseId: row.caseId,
          reportId: row.reportId,
        }),
        { id: row.id, version: row.version },
      );
    } catch (error: unknown) {
      if (error instanceof ORPCError) throw error;
      return deny();
    }
    const [completed] = await context.DB.select()
      .from(installmentWorkflows)
      .where(eq(installmentWorkflows.id, row.id));
    await prompt(context, completed, route);
    if (callback)
      await client.answerCallbackQuery(callback.id, '分期計畫已建立。');
    return { code: 'INSTALLMENT_CREATED', reportId: row.reportId };
  } else if (
    row.step === 'type' &&
    ['deadline', 'weekly', 'monthly'].includes(action ?? '')
  ) {
    data.planType = action as 'deadline' | 'weekly' | 'monthly';
    step =
      action === 'deadline'
        ? 'deadline'
        : action === 'weekly'
          ? 'weekday'
          : 'monthday';
  } else if (row.step === 'weekday' && action?.startsWith('week')) {
    data.weekday = Number(action.slice(4));
    step = 'per';
  } else if (row.step === 'monthday' && action?.startsWith('day')) {
    data.dayOfMonth = Number(action.slice(3));
    step = 'per';
  } else if (row.step === 'monthday' && action === 'custom') step = 'customday';
  else if (!callback) {
    const text = update.message?.text?.trim() ?? '';
    try {
      if (row.step === 'deadline') {
        data.deadlineDate = dateSchema.parse(text.replaceAll('/', '-'));
        if (data.deadlineDate < businessToday()) throw new Error('past');
        step = 'total';
      } else if (row.step === 'customday') {
        data.dayOfMonth = z
          .number()
          .int()
          .min(1)
          .max(31)
          .parse(/^\d+$/.test(text) ? Number(text) : NaN);
        step = 'per';
      } else if (row.step === 'per' || row.step === 'total') {
        const amount = moneySchema.parse(
          /^\d+(?:,\d{3})*$/.test(text)
            ? Number(text.replaceAll(',', ''))
            : NaN,
        );
        if (row.step === 'per') {
          data.perPaymentAmount = amount;
          step = 'total';
        } else {
          data.totalAmount = amount;
          planCreateSchema.parse({
            ...data,
            caseId: row.caseId,
            reportId: row.reportId,
          });
          step = 'confirm';
        }
      } else throw new Error('unexpected');
    } catch {
      await queueTelegramMessage(
        context,
        route,
        `installment-invalid:${update.update_id}`,
        '輸入格式不正確，請依上一則提示重新輸入。',
        row.reportId,
        { commandReply: true },
      );
      return { code: 'INSTALLMENT_INVALID_INPUT', reportId: row.reportId };
    }
  } else return deny();
  const token = crypto.randomUUID(),
    now = Date.now();
  await atomicCaseWrite(context, [
    base.env.DB.prepare(
      `UPDATE installment_workflows SET data=?,step=?,status=?,last_update_id=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND status='active' AND expires_at>? AND ${scopeSql}`,
    ).bind(
      JSON.stringify(dataSchema.parse(data)),
      step,
      status,
      String(update.update_id),
      now,
      token,
      row.id,
      row.version,
      now,
    ),
    financeAudit(
      context,
      row.caseId,
      status === 'cancelled'
        ? 'installment.workflow_cancelled'
        : 'installment.workflow_advanced',
      row.id,
      {
        sql: 'EXISTS(SELECT 1 FROM installment_workflows WHERE id=? AND write_token=?)',
        values: [row.id, token],
      },
    ),
  ]);
  const [latest] = await context.DB.select()
    .from(installmentWorkflows)
    .where(eq(installmentWorkflows.id, row.id));
  await prompt(context, latest, route);
  if (callback)
    await client.answerCallbackQuery(callback.id, '已更新分期設定。');
  return { code: 'INSTALLMENT_UPDATED', reportId: row.reportId };
}
