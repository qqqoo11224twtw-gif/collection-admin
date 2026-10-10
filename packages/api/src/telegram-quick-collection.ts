import { ORPCError } from '@orpc/server';
import type { telegramRoutes } from '@saasflare-dev/db';
import { atomicCaseWrite } from './audit';
import { requireCaseAccess } from './case-access';
import type { Context } from './context';
import { createPayment } from './finance';
import { financeAudit } from './finance-audit';
import { businessToday, moneySchema } from './finance-contract';
import { requirePermission } from './permissions';
import type { TelegramClient } from './telegram-client';
import type { TelegramUpdate } from './telegram-contract';
import { normalizeReportName, refreshReportNames } from './telegram-name-index';
import {
  queueReportDestination,
  queueTelegramMessage,
} from './telegram-outbound';
import { bindReportMedia } from './telegram-report-media';
import { reportRoutePrincipal } from './telegram-report-principal';

// Collection keeps its existing deadline; the new two-minute rule is /回報 only.
const COLLECTION_CONVERSATION_TTL_MS = 20 * 60 * 1000;

type Route = typeof telegramRoutes.$inferSelect;
type Candidate = {
  id: string;
  assignment_id: string;
  code: string;
  customer_name: string;
  region: string | null;
};
type Draft = {
  id: string;
  route_id: string;
  collector_id: string;
  stage: string;
  candidates: string;
  case_id: string | null;
  assignment_id: string | null;
  report_id: string | null;
  collection_amount: number;
  expires_at: number;
  created_at: number;
  origin_update_id: string;
};
const formatHelp =
  '格式錯誤，請輸入：\n/收款 客戶姓名 金額\n\n例如：\n/收款 王小明 5000';
export function parseCollectionCommand(text: string) {
  const matched = /^\/收款(?:@[A-Za-z0-9_]+)?\s+([^\r\n]+?)\s+([0-9]+)$/u.exec(
    text.trim(),
  );
  if (!matched) return null;
  const name = normalizeReportName(matched[1]),
    amount = Number(matched[2]);
  return name.length > 0 &&
    name.length <= 120 &&
    moneySchema.safeParse(amount).success
    ? { name, amount }
    : null;
}
function candidatesKeyboard(id: string, candidates: Candidate[], page = 0) {
  const rows = candidates.slice(page * 6, page * 6 + 6).map((c, index) => [
    {
      text: `${c.code.slice(0, 22)}｜${c.customer_name.slice(0, 22)}｜${(c.region || '未設定地區').slice(0, 18)}`,
      callback_data: `pc:${id}:${page * 6 + index}`,
    },
  ]);
  if (page)
    rows.push([{ text: '上一頁', callback_data: `pp:${id}:${page - 1}` }]);
  if (page * 6 + 6 < candidates.length)
    rows.push([{ text: '下一頁', callback_data: `pp:${id}:${page + 1}` }]);
  return { inline_keyboard: rows };
}
export async function collectionReceipt(
  context: Context,
  caseId: string,
  paymentId: string,
  direct = false,
) {
  const c = await context.env.DB.prepare(
    'SELECT code,customer_name,status FROM cases WHERE id=?',
  )
    .bind(caseId)
    .first<{
      code: string;
      customer_name: string;
      status: string;
    }>();
  const p = await context.env.DB.prepare(
    'SELECT received_amount,collector_id FROM payments WHERE id=?',
  )
    .bind(paymentId)
    .first<{ received_amount: number; collector_id: string | null }>();
  const paid = await context.env.DB.prepare(
    "SELECT coalesce(sum(received_amount),0) AS amount FROM payments WHERE case_id=? AND status='received'",
  )
    .bind(caseId)
    .first<{ amount: number }>();
  if (!c || !p) throw new ORPCError('NOT_FOUND');
  if (direct) {
    const o = await context.env.DB.prepare(
      'SELECT amount FROM collector_offsets WHERE source_payment_id=?',
    )
      .bind(paymentId)
      .first<{ amount: number }>();
    return `已完成回報\n案件：${c.customer_name} / ${c.code}\n狀態：後結\n客戶匯案主：${p.received_amount}\n後結抵扣：${o?.amount ?? 0}`;
  }
  return `已完成收款\n案件：${c.customer_name} / ${c.code}\n本次收款：${p.received_amount}\n累計已收：${paid?.amount ?? 0}${c.status === 'settled' ? '\n狀態：已結清' : ''}`;
}
async function finishCollection(
  base: Context,
  update: TelegramUpdate,
  route: Route,
  draft: Draft,
) {
  const context = await reportRoutePrincipal(base, route, update);
  requirePermission(context, 'case.view');
  requirePermission(context, 'payment.create');
  requirePermission(context, 'report.create');
  if (
    !draft.case_id ||
    !draft.assignment_id ||
    draft.expires_at <= Date.now() ||
    ['cancelled', 'expired'].includes(draft.stage)
  )
    throw new ORPCError('FORBIDDEN');
  const c = await requireCaseAccess(context, draft.case_id, 'payment.create');
  const valid = await context.env.DB.prepare(
    'SELECT id FROM assignments WHERE id=? AND case_id=? AND collector_id=? AND unassigned_at IS NULL',
  )
    .bind(draft.assignment_id, c.id, route.collectorId)
    .first();
  if (!valid) throw new ORPCError('FORBIDDEN');
  let reportId = draft.report_id;
  if (!reportId) {
    const id = crypto.randomUUID(),
      token = crypto.randomUUID(),
      now = Date.now();
    await atomicCaseWrite(context, [
      context.env.DB.prepare(
        "UPDATE cases SET updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND voided_at IS NULL AND EXISTS(SELECT 1 FROM telegram_report_conversations conv JOIN telegram_routes r ON r.id=conv.route_id JOIN collectors col ON col.id=conv.collector_id JOIN assignments a ON a.id=conv.assignment_id WHERE conv.id=? AND conv.stage='submitting' AND conv.expires_at>? AND conv.report_id IS NULL AND r.is_active=1 AND col.is_active=1 AND r.collector_id=col.id AND a.unassigned_at IS NULL AND a.collector_id=col.id AND a.case_id=cases.id)",
      ).bind(now, token, c.id, c.version, draft.id, now),
      context.env.DB.prepare(
        "INSERT INTO reports(id,case_id,assignment_id,collector_id,created_by_user_id,content,status,source,origin_key,workflow_status,callback_token,telegram_user_id,callback_route_id,finance_event,created_at,updated_at) SELECT ?,?,?,?,?,?,'needs_review','telegram',?,'awaiting_status',?,?,?,'payment',?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
      ).bind(
        id,
        c.id,
        draft.assignment_id,
        route.collectorId,
        context.user?.id,
        `實際收款 ${draft.collection_amount}`,
        `telegram-collection:${draft.origin_update_id}`,
        crypto.randomUUID().replaceAll('-', ''),
        String(update.message?.from?.id ?? update.callback_query?.from.id ?? 1),
        route.id,
        now,
        now,
        c.id,
        token,
      ),
      context.env.DB.prepare(
        "UPDATE telegram_report_conversations SET report_id=?,stage='status',updated_at=? WHERE id=? AND report_id IS NULL AND EXISTS(SELECT 1 FROM reports WHERE id=?)",
      ).bind(id, now, draft.id, id),
      financeAudit(context, c.id, 'report.created', id, {
        sql: 'EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
        values: [c.id, token],
      }),
    ]);
    reportId = id;
  }
  const payment = await createPayment(
    context,
    {
      caseId: c.id,
      idempotencyKey: reportId,
      receivedAmount: draft.collection_amount,
      receivedDate: businessToday(new Date(draft.created_at)),
      installmentScheduleId: null,
    },
    {
      reportId,
      assignmentId: draft.assignment_id,
      routeId: route.id,
      kind: 'payment',
    },
  );
  await queueReportDestination(context, reportId);
  await queueTelegramMessage(
    context,
    route,
    `collection-completed:${reportId}`,
    await collectionReceipt(context, c.id, payment.id),
    reportId,
    { commandReply: true },
  );
  return {
    code: payment.duplicate ? 'PAYMENT_ALREADY_COMPLETED' : 'PAYMENT_COMPLETED',
    reportId,
  };
}
export async function processCollectionCommand(
  base: Context,
  update: TelegramUpdate,
  route: Route,
) {
  const key = String(update.update_id),
    parsed = parseCollectionCommand(
      update.message?.text ?? update.message?.caption ?? '',
    );
  const reply = (text: string) =>
    queueTelegramMessage(base, route, `collection-reply:${key}`, text, null, {
      commandReply: true,
    });
  if (!parsed) {
    await reply(formatHelp);
    return { code: 'PAYMENT_FORMAT_INVALID', reportId: null };
  }
  let context: Context;
  try {
    context = await reportRoutePrincipal(base, route, update);
    requirePermission(context, 'case.view');
    requirePermission(context, 'payment.create');
    requirePermission(context, 'report.create');
  } catch {
    await reply(
      '目前群組尚未完成外收收款設定，或外收人員未啟用。請聯絡管理員。',
    );
    return { code: 'PAYMENT_ROUTE_DENIED', reportId: null };
  }
  const prior = await base.env.DB.prepare(
    "SELECT * FROM telegram_report_conversations WHERE origin_update_id=? AND kind='payment'",
  )
    .bind(key)
    .first<Draft>();
  if (prior) {
    if (prior.case_id && !['cancelled', 'expired'].includes(prior.stage))
      return finishCollection(context, update, route, prior);
    return { code: 'PAYMENT_SELECTION_PENDING', reportId: prior.report_id };
  }
  await refreshReportNames(context);
  const candidates = (
    await context.env.DB.prepare(
      'SELECT c.id,a.id AS assignment_id,c.code,c.customer_name,c.region FROM cases c JOIN assignments a ON a.case_id=c.id JOIN collectors col ON col.id=a.collector_id WHERE c.report_name=? AND a.collector_id=? AND a.unassigned_at IS NULL AND col.is_active=1 AND c.voided_at IS NULL ORDER BY c.id',
    )
      .bind(parsed.name, route.collectorId)
      .all<Candidate>()
  ).results;
  const now = Date.now(),
    id = crypto.randomUUID().replaceAll('-', ''),
    single = candidates.length === 1 ? candidates[0] : null;
  await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE telegram_report_conversations SET stage='cancelled',updated_at=? WHERE route_id=? AND kind='payment' AND stage IN ('selecting','content','submitting','status')",
    ).bind(now, route.id),
    context.env.DB.prepare(
      "INSERT INTO telegram_report_conversations(id,route_id,collector_id,kind,collection_amount,stage,candidates,case_id,assignment_id,origin_update_id,expires_at,created_at,updated_at) VALUES(?,?,?,'payment',?,?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      route.id,
      route.collectorId,
      parsed.amount,
      !candidates.length ? 'cancelled' : single ? 'submitting' : 'selecting',
      JSON.stringify(
        candidates.map((c) => ({ id: c.id, assignment_id: c.assignment_id })),
      ),
      single?.id ?? null,
      single?.assignment_id ?? null,
      key,
      now + COLLECTION_CONVERSATION_TTL_MS,
      now,
      now,
    ),
  ]);
  await bindReportMedia(context, update, route.id, id);
  if (!candidates.length) {
    await reply(`找不到「${parsed.name}」的可收款案件。\n請確認姓名是否正確。`);
    return { code: 'PAYMENT_NO_MATCH', reportId: null };
  }
  if (!single) {
    await queueTelegramMessage(
      context,
      route,
      `collection-reply:${key}`,
      '找到多筆同名案件，請選擇：',
      null,
      { replyMarkup: candidatesKeyboard(id, candidates), commandReply: true },
    );
    return { code: 'PAYMENT_AMBIGUOUS', reportId: null };
  }
  const draft = await context.env.DB.prepare(
    'SELECT * FROM telegram_report_conversations WHERE id=?',
  )
    .bind(id)
    .first<Draft>();
  if (!draft) throw new ORPCError('CONFLICT');
  try {
    return await finishCollection(context, update, route, draft);
  } catch (error) {
    if (error instanceof ORPCError && error.code === 'BAD_REQUEST') {
      await reply(error.message);
      return { code: 'PAYMENT_REJECTED', reportId: draft.report_id };
    }
    throw error;
  }
}
export async function processCollectionCallback(
  base: Context,
  update: TelegramUpdate,
  route: Route,
  client: TelegramClient,
) {
  const query = update.callback_query,
    match = /^(pc|pp):([a-f0-9]{32}):(\d{1,5})$/.exec(query?.data ?? '');
  const deny = async () => {
    if (query)
      await client.answerCallbackQuery(
        query.id,
        '收款選案已失效，請重新輸入：/收款 客戶姓名 金額',
      );
    return { code: 'PAYMENT_CALLBACK_DENIED', reportId: null };
  };
  if (!query || !match) return deny();
  const draft = await base.env.DB.prepare(
    "SELECT * FROM telegram_report_conversations WHERE id=? AND kind='payment'",
  )
    .bind(match[2])
    .first<Draft>();
  if (
    !draft ||
    draft.route_id !== route.id ||
    draft.collector_id !== route.collectorId ||
    draft.expires_at <= Date.now() ||
    ['cancelled', 'expired'].includes(draft.stage)
  )
    return deny();
  let context: Context;
  try {
    context = await reportRoutePrincipal(base, route, update);
    requirePermission(context, 'payment.create');
  } catch {
    return deny();
  }
  const ids = JSON.parse(draft.candidates) as {
    id: string;
    assignment_id: string;
  }[];
  if (match[1] === 'pp') {
    const page = Number(match[3]);
    if (draft.stage !== 'selecting' || page * 6 >= ids.length) return deny();
    const shown: Candidate[] = [];
    for (const item of ids.slice(page * 6, page * 6 + 6)) {
      try {
        const c = await requireCaseAccess(context, item.id, 'payment.create');
        const a = await context.env.DB.prepare(
          'SELECT id FROM assignments WHERE id=? AND case_id=? AND collector_id=? AND unassigned_at IS NULL',
        )
          .bind(item.assignment_id, item.id, route.collectorId)
          .first();
        if (!a) return deny();
        shown.push({
          id: c.id,
          assignment_id: item.assignment_id,
          code: c.code,
          customer_name: c.customerName,
          region: c.region,
        });
      } catch {
        return deny();
      }
    }
    const keyboard = {
      inline_keyboard: shown.map((c, i) => [
        {
          text: `${c.code.slice(0, 22)}｜${c.customer_name.slice(0, 22)}｜${(c.region || '未設定地區').slice(0, 18)}`,
          callback_data: `pc:${draft.id}:${page * 6 + i}`,
        },
      ]),
    };
    if (page)
      keyboard.inline_keyboard.push([
        { text: '上一頁', callback_data: `pp:${draft.id}:${page - 1}` },
      ]);
    if (page * 6 + 6 < ids.length)
      keyboard.inline_keyboard.push([
        { text: '下一頁', callback_data: `pp:${draft.id}:${page + 1}` },
      ]);
    await queueTelegramMessage(
      context,
      route,
      `collection-page:${update.update_id}`,
      '找到多筆同名案件，請選擇：',
      null,
      { replyMarkup: keyboard, commandReply: true },
    );
    await client.answerCallbackQuery(query.id, '請選擇案件');
    return { code: 'PAYMENT_AMBIGUOUS', reportId: null };
  }
  const selected = ids[Number(match[3])];
  if (!selected) return deny();
  if (draft.case_id && draft.case_id !== selected.id) return deny();
  if (draft.stage === 'selecting') {
    await base.env.DB.prepare(
      "UPDATE telegram_report_conversations SET case_id=?,assignment_id=?,stage='submitting',updated_at=? WHERE id=? AND stage='selecting' AND expires_at>? AND EXISTS(SELECT 1 FROM assignments a JOIN cases c ON c.id=a.case_id JOIN collectors col ON col.id=a.collector_id WHERE a.id=? AND a.case_id=? AND a.collector_id=? AND a.unassigned_at IS NULL AND col.is_active=1 AND c.voided_at IS NULL)",
    )
      .bind(
        selected.id,
        selected.assignment_id,
        Date.now(),
        draft.id,
        Date.now(),
        selected.assignment_id,
        selected.id,
        route.collectorId,
      )
      .run();
  }
  const fresh = await base.env.DB.prepare(
    'SELECT * FROM telegram_report_conversations WHERE id=?',
  )
    .bind(draft.id)
    .first<Draft>();
  if (!fresh || fresh.case_id !== selected.id) return deny();
  await client.answerCallbackQuery(query.id, '正在確認收款');
  try {
    return await finishCollection(context, update, route, fresh);
  } catch (error) {
    if (error instanceof ORPCError && error.code === 'BAD_REQUEST') {
      await queueTelegramMessage(
        context,
        route,
        `collection-error:${update.update_id}`,
        error.message,
        null,
        { commandReply: true },
      );
      return { code: 'PAYMENT_REJECTED', reportId: fresh.report_id };
    }
    return deny();
  }
}

export async function processDirectPaymentText(
  base: Context,
  update: TelegramUpdate,
  route: Route,
) {
  const pending = await base.env.DB.prepare(
    "SELECT r.id,r.case_id,r.assignment_id,r.created_at FROM reports r JOIN telegram_report_conversations conv ON conv.report_id=r.id WHERE r.callback_route_id=? AND r.workflow_status='awaiting_status' AND r.selected_status='direct_to_principal' AND conv.stage='status' AND conv.expires_at>? LIMIT 1",
  )
    .bind(route.id, Date.now())
    .first<{
      id: string;
      case_id: string;
      assignment_id: string;
      created_at: number;
    }>();
  if (!pending) return null;
  const text = update.message?.text?.trim() ?? '',
    amount = /^[0-9]+$/.test(text) ? Number(text) : 0;
  if (!moneySchema.safeParse(amount).success) {
    await queueTelegramMessage(
      base,
      route,
      `direct-invalid:${update.update_id}`,
      '請輸入客戶本次直接匯給案主的金額（大於零的整數台幣）。',
      pending.id,
      { commandReply: true },
    );
    return { code: 'DIRECT_PAYMENT_INVALID', reportId: pending.id };
  }
  const context = await reportRoutePrincipal(base, route, update);
  try {
    const payment = await createPayment(
      context,
      {
        caseId: pending.case_id,
        idempotencyKey: pending.id,
        receivedAmount: amount,
        receivedDate: businessToday(
          new Date(pending.created_at),
          base.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
        ),
        installmentScheduleId: null,
      },
      {
        reportId: pending.id,
        assignmentId: pending.assignment_id,
        routeId: route.id,
        kind: 'offset',
      },
    );
    await queueReportDestination(context, pending.id);
    await queueTelegramMessage(
      context,
      route,
      `direct-completed:${pending.id}`,
      await collectionReceipt(context, pending.case_id, payment.id, true),
      pending.id,
      { commandReply: true },
    );
    return { code: 'DIRECT_PAYMENT_COMPLETED', reportId: pending.id };
  } catch (error) {
    if (error instanceof ORPCError && error.code === 'BAD_REQUEST') {
      await queueTelegramMessage(
        context,
        route,
        `direct-error:${update.update_id}`,
        error.message,
        pending.id,
        { commandReply: true },
      );
      return { code: 'DIRECT_PAYMENT_REJECTED', reportId: pending.id };
    }
    throw error;
  }
}

export async function processCollectionMedia(
  base: Context,
  update: TelegramUpdate,
  route: Route,
  conversationId: string | null,
) {
  const message = update.message;
  if (!message) return null;
  const id =
    conversationId ??
    (message.media_group_id
      ? (
          await base.env.DB.prepare(
            'SELECT conversation_id FROM telegram_report_media WHERE route_id=? AND media_group_id=? AND conversation_id IS NOT NULL LIMIT 1',
          )
            .bind(route.id, message.media_group_id)
            .first<{ conversation_id: string }>()
        )?.conversation_id
      : null);
  if (!id) return null;
  const draft = await base.env.DB.prepare(
    "SELECT * FROM telegram_report_conversations WHERE id=? AND kind='payment'",
  )
    .bind(id)
    .first<Draft>();
  if (!draft) return null;
  const denied = () => ({
    code: 'PAYMENT_MEDIA_DENIED',
    reportId: draft.report_id,
  });
  if (
    draft.route_id !== route.id ||
    draft.collector_id !== route.collectorId ||
    draft.expires_at <= Date.now() ||
    ['cancelled', 'expired'].includes(draft.stage)
  )
    return denied();
  const context = await reportRoutePrincipal(base, route, update);
  requirePermission(context, 'payment.create');
  if (draft.case_id) {
    await requireCaseAccess(context, draft.case_id, 'payment.create');
    const assignment = await base.env.DB.prepare(
      'SELECT id FROM assignments WHERE id=? AND case_id=? AND collector_id=? AND unassigned_at IS NULL',
    )
      .bind(draft.assignment_id, draft.case_id, route.collectorId)
      .first();
    if (!assignment) return denied();
  }
  if (draft.stage !== 'completed') {
    await bindReportMedia(context, update, route.id, draft.id);
    return { code: 'PAYMENT_MEDIA_RECEIVED', reportId: draft.report_id };
  }
  // A completed quick payment accepts only fragments of its original album,
  // within a bounded receipt window. Later standalone photos never attach.
  if (!message.media_group_id) return denied();
  const changed = await base.env.DB.prepare(
    'UPDATE telegram_report_media SET conversation_id=?,accepted_at=? WHERE id=? AND route_id=? AND accepted_at IS NULL AND media_group_id=(SELECT media_group_id FROM telegram_report_media WHERE id=?) AND received_at<=(SELECT created_at+120000 FROM telegram_report_conversations WHERE id=?) AND EXISTS(SELECT 1 FROM telegram_report_media original WHERE original.id=? AND original.conversation_id=? AND original.accepted_at>0)',
  )
    .bind(
      draft.id,
      Date.now(),
      String(update.update_id),
      route.id,
      draft.origin_update_id,
      draft.id,
      draft.origin_update_id,
      draft.id,
    )
    .run();
  return {
    code: changed.meta.changes
      ? 'PAYMENT_MEDIA_RECEIVED'
      : 'PAYMENT_MEDIA_DENIED',
    reportId: draft.report_id,
  };
}
