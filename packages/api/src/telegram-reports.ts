import type { telegramRoutes } from '@saasflare-dev/db';
import { requireCaseAccess } from './case-access';
import type { Context } from './context';
import { requirePermission } from './permissions';
import { createReport } from './reports';
import { systemLog } from './system-log';
import { telegramAudit } from './telegram-adapter';
import type { TelegramClient } from './telegram-client';
import type { TelegramUpdate } from './telegram-contract';
import { reportStatusKeyboard } from './telegram-contract';
import { normalizeReportName, refreshReportNames } from './telegram-name-index';
import {
  queueReportDestination,
  queueTelegramMessage,
} from './telegram-outbound';
import { expireReportConversations } from './telegram-report-expiry';
import { bindReportMedia } from './telegram-report-media';
import { reportRoutePrincipal } from './telegram-report-principal';

export { normalizeReportName } from './telegram-name-index';

export async function queueStatusPrompt(
  context: Context,
  route: typeof telegramRoutes.$inferSelect,
  id: string,
  client?: TelegramClient,
) {
  const report = await context.env.DB.prepare(
    "SELECT r.callback_token,r.content,c.code,c.customer_name,(SELECT count(*) FROM telegram_report_media m JOIN telegram_report_conversations conv ON conv.id=m.conversation_id WHERE conv.report_id=r.id AND m.accepted_at>0) AS media_count FROM reports r JOIN cases c ON c.id=r.case_id WHERE r.id=? AND r.workflow_status='awaiting_status'",
  )
    .bind(id)
    .first<{
      callback_token: string;
      content: string;
      media_count: number;
      code: string;
      customer_name: string;
    }>();
  if (!report) return;
  const text = `已收到回報\n代號：${report.code}\n客戶姓名：${report.customer_name}\n回報內容：${report.content}\n圖片張數：${report.media_count}\n請選擇案件狀態`;
  if (client?.editReportPrompt) {
    const sent = await context.env.DB.prepare(
      "SELECT telegram_message_id FROM telegram_outbound_jobs WHERE dedupe_key=? AND status='sent'",
    )
      .bind(`report-status-prompt:${id}`)
      .first<{ telegram_message_id: string }>();
    if (sent) {
      try {
        await client.editReportPrompt(
          {
            chatId: route.chatId,
            topicId: route.topicId,
            text,
            replyMarkup: reportStatusKeyboard(report.callback_token),
          },
          sent.telegram_message_id,
        );
      } catch {
        /* Edits are replaceable; no new status message or business transition. */
      }
      return;
    }
  }
  await queueTelegramMessage(
    context,
    route,
    `report-status-prompt:${id}`,
    text,
    id,
    {
      commandReply: true,
      replyMarkup: reportStatusKeyboard(report.callback_token),
    },
  );
}

export const REPORT_CONVERSATION_TTL_MS = 2 * 60 * 1000;
export function parseReportCommand(text: string) {
  const match = /^\/回報(?:@[A-Za-z0-9_]+)?\s+([^\r\n]+)$/.exec(text.trim());
  const name = match ? normalizeReportName(match[1]) : '';
  return name && name.length <= 3620 ? { name } : null;
}
type Route = typeof telegramRoutes.$inferSelect;
type Candidate = {
  id: string;
  assignment_id: string;
  code: string;
  customer_name: string;
  region: string | null;
};
type Conversation = {
  id: string;
  route_id: string;
  collector_id: string;
  stage: string;
  candidates: string;
  case_id: string | null;
  assignment_id: string | null;
  report_id: string | null;
  expires_at: number;
  created_at: number;
  message_received_at: number | null;
  content_update_id: string | null;
  draft_content: string | null;
};
const label = (c: Candidate) =>
  [c.code, c.customer_name, c.region || '未設定地區'].join('｜');
const buttonLabel = (c: Candidate) =>
  [
    c.code.slice(0, 22),
    c.customer_name.slice(0, 22),
    (c.region || '未設定地區').slice(0, 18),
  ].join('｜');
const expiredText = '回報已逾時失敗，請重新輸入 /回報。';
async function principal(base: Context, route: Route, update: TelegramUpdate) {
  const ctx = await reportRoutePrincipal(base, route, update);
  requirePermission(ctx, 'case.view');
  requirePermission(ctx, 'report.create');
  return ctx;
}
async function eligible(ctx: Context, route: Route, c: Conversation) {
  if (!c.case_id || !c.assignment_id) return null;
  const record = await requireCaseAccess(ctx, c.case_id, 'report.create');
  const assignment = await ctx.env.DB.prepare(
    'SELECT id FROM assignments WHERE id=? AND case_id=? AND collector_id=? AND unassigned_at IS NULL',
  )
    .bind(c.assignment_id, c.case_id, route.collectorId)
    .first();
  if (!assignment) return null;
  return record;
}
export async function validateReportMedia(
  base: Context,
  update: TelegramUpdate,
  route: Route,
  id: string,
) {
  const ctx = await principal(base, route, update);
  const conv = await base.env.DB.prepare(
    "SELECT * FROM telegram_report_conversations WHERE id=? AND route_id=? AND collector_id=? AND kind='report'",
  )
    .bind(id, route.id, route.collectorId)
    .first<Conversation>();
  if (
    !conv ||
    conv.expires_at <= Date.now() ||
    !['selecting', 'content', 'submitting', 'status'].includes(conv.stage)
  )
    return null;
  if (conv.case_id && !(await eligible(ctx, route, conv))) return null;
  if (
    conv.report_id &&
    !(await base.env.DB.prepare(
      "SELECT id FROM reports WHERE id=? AND workflow_status='awaiting_status' AND selected_status IS NULL",
    )
      .bind(conv.report_id)
      .first())
  )
    return null;
  return conv;
}
export async function processReportCommand(
  base: Context,
  update: TelegramUpdate,
  route: Route,
) {
  const updateId = String(update.update_id),
    command = parseReportCommand(
      update.message?.text ?? update.message?.caption ?? '',
    );
  const reply = (text: string) =>
    queueTelegramMessage(base, route, `command-reply:${updateId}`, text);
  if (!command) {
    await reply('請使用 /回報 客戶姓名。');
    return { code: 'INVALID_COMMAND', reportId: null };
  }
  let ctx: Context;
  try {
    ctx = await principal(base, route, update);
  } catch {
    await systemLog(base.env.DB, {
      category: 'telegram',
      event: 'REPORT_ROUTE_DENIED',
      status: 'failed',
      level: 'warning',
      errorCode: 'REPORT_ROUTE_DENIED',
      relatedRouteId: route.id,
      safeMessage: '回報群組未綁定有效外收人員或帳號無回報權限。',
    });
    await reply(
      '無法接受回報，請聯絡管理員確認外收人員是否啟用及回報群組設定。',
    );
    return { code: 'ROUTE_DENIED', reportId: null };
  }
  const replay = await ctx.env.DB.prepare(
    'SELECT * FROM telegram_report_conversations WHERE origin_update_id=?',
  )
    .bind(updateId)
    .first<Conversation>();
  if (replay) {
    if (
      replay.draft_content &&
      ['content', 'submitting'].includes(replay.stage) &&
      update.message
    ) {
      return (
        (await processReportContent(
          ctx,
          {
            ...update,
            message: { ...update.message, text: replay.draft_content },
          },
          route,
        )) ?? { code: 'INVALID_REPORT_CONTENT', reportId: null }
      );
    }
    if (replay.stage === 'status' && replay.report_id) {
      await queueStatusPrompt(ctx, route, replay.report_id);
      return { code: 'REPORT_PENDING', reportId: replay.report_id };
    }
    if (
      replay.expires_at <= Date.now() ||
      !['content', 'selecting'].includes(replay.stage)
    )
      return {
        code: 'CONVERSATION_ALREADY_STARTED',
        reportId: replay.report_id,
      };
    const ids = JSON.parse(replay.candidates) as {
      id: string;
      assignment_id: string;
    }[];
    const found: Candidate[] = [];
    for (const c of ids) {
      try {
        const record = await eligible(ctx, route, {
          ...replay,
          case_id: c.id,
          assignment_id: c.assignment_id,
        });
        if (!record) return { code: 'CASE_DENIED', reportId: null };
        found.push({
          id: record.id,
          assignment_id: c.assignment_id,
          code: record.code,
          customer_name: record.customerName,
          region: record.region,
        });
      } catch {
        return { code: 'CASE_DENIED', reportId: null };
      }
    }
    if (replay.stage === 'content' && found[0])
      await reply(`找到案件：\n${label(found[0])}\n\n請輸入回報內容：`);
    else if (found.length)
      await queueTelegramMessage(
        ctx,
        route,
        `command-reply:${updateId}`,
        '找到多筆同名案件，請選擇您要回報的案件：',
        null,
        {
          replyMarkup: {
            inline_keyboard: selectionKeyboard(replay.id, found, 0),
          },
        },
      );
    return {
      code:
        replay.stage === 'content' ? 'AWAITING_REPORT_CONTENT' : 'AMBIGUOUS',
      reportId: null,
    };
  }
  // Read only this collector's valid assignment scope. Normalize exactly, never fuzzy-match.
  const lookupStarted = performance.now();
  await refreshReportNames(ctx);
  let all = await ctx.env.DB.prepare(
    'SELECT c.id,a.id AS assignment_id,c.code,c.customer_name,c.region FROM cases c JOIN assignments a ON a.case_id=c.id JOIN collectors col ON col.id=a.collector_id WHERE c.report_name=? AND a.collector_id=? AND a.unassigned_at IS NULL AND col.is_active=1 AND c.voided_at IS NULL ORDER BY c.id',
  )
    .bind(command.name, route.collectorId)
    .all<Candidate>();
  let inlineContent = '';
  if (!all.results.length) {
    // Exact names first; then exact whitespace-delimited prefixes, longest first.
    // Never use fuzzy matching or another collector's case as a parsing hint.
    const raw = (update.message?.text ?? update.message?.caption ?? '')
      .trim()
      .replace(/^\/回報(?:@[A-Za-z0-9_]+)?\s+/u, '');
    const prefixes = [...raw.matchAll(/\s+/gu)]
      .map((m) => ({
        name: normalizeReportName(raw.slice(0, m.index)),
        end: m.index + m[0].length,
      }))
      .filter((p) => p.name.length <= 120)
      .reverse();
    if (prefixes.length) {
      const result = await ctx.env.DB.prepare(
        `SELECT c.id,a.id AS assignment_id,c.code,c.customer_name,c.region,c.report_name FROM cases c JOIN assignments a ON a.case_id=c.id JOIN collectors col ON col.id=a.collector_id WHERE c.report_name IN (${prefixes.map(() => '?').join(',')}) AND a.collector_id=? AND a.unassigned_at IS NULL AND col.is_active=1 AND c.voided_at IS NULL ORDER BY c.id`,
      )
        .bind(...prefixes.map((p) => p.name), route.collectorId)
        .all<Candidate & { report_name: string }>();
      const prefix = prefixes.find((p) =>
        result.results.some((c) => c.report_name === p.name),
      );
      if (prefix) {
        all = {
          ...result,
          results: result.results.filter((c) => c.report_name === prefix.name),
        };
        inlineContent = raw.slice(prefix.end).trim();
      }
    }
  }
  if (ctx.telegramTiming)
    ctx.telegramTiming.case_lookup_ms += performance.now() - lookupStarted;
  const candidates = all.results;
  const now = Date.now(),
    id = crypto.randomUUID().replaceAll('-', ''),
    single = candidates.length === 1 ? candidates[0] : null;
  const writeStarted = performance.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "UPDATE telegram_report_conversations SET stage='cancelled',updated_at=? WHERE route_id=? AND kind='report' AND stage IN ('selecting','content','submitting','status')",
    ).bind(now, route.id),
    ctx.env.DB.prepare(
      'INSERT INTO telegram_report_conversations(id,route_id,collector_id,stage,candidates,case_id,assignment_id,origin_update_id,expires_at,message_received_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(
      id,
      route.id,
      route.collectorId,
      !candidates.length ? 'cancelled' : single ? 'content' : 'selecting',
      JSON.stringify(
        candidates.map((c) => ({ id: c.id, assignment_id: c.assignment_id })),
      ),
      single?.id ?? null,
      single?.assignment_id ?? null,
      updateId,
      now + REPORT_CONVERSATION_TTL_MS,
      (update.message?.date ?? Math.floor(now / 1000)) * 1000,
      now,
      now,
    ),
  ]);
  if (ctx.telegramTiming)
    ctx.telegramTiming.conversation_write_ms +=
      performance.now() - writeStarted;
  await bindReportMedia(ctx, update, route.id, id);
  if (inlineContent)
    await ctx.env.DB.prepare(
      'UPDATE telegram_report_conversations SET draft_content=? WHERE id=?',
    )
      .bind(inlineContent, id)
      .run();
  if (!candidates.length) {
    await reply(
      `找不到「${command.name}」的可回報案件。\n請確認姓名是否正確。`,
    );
    return { code: 'CASE_DENIED', reportId: null };
  }
  if (single) {
    if (inlineContent && update.message)
      return (
        (await processReportContent(
          ctx,
          { ...update, message: { ...update.message, text: inlineContent } },
          route,
        )) ?? { code: 'INVALID_REPORT_CONTENT', reportId: null }
      );
    await reply(`找到案件：\n${label(single)}\n\n請輸入回報內容：`);
    return { code: 'AWAITING_REPORT_CONTENT', reportId: null };
  }
  await queueTelegramMessage(
    ctx,
    route,
    `command-reply:${updateId}`,
    '找到多筆同名案件，請選擇您要回報的案件：',
    null,
    {
      replyMarkup: {
        inline_keyboard: selectionKeyboard(id, candidates, 0),
      },
    },
  );
  await telegramAudit(ctx, 'telegram.report_lookup_ambiguous', updateId, {
    count: candidates.length,
  }).run();
  return { code: 'AMBIGUOUS', reportId: null };
}
function selectionKeyboard(id: string, candidates: Candidate[], page: number) {
  const offset = page * 6;
  const rows = candidates
    .slice(offset, offset + 6)
    .map((c, i) => [
      { text: buttonLabel(c), callback_data: `rc:${id}:${offset + i}` },
    ]);
  if (page > 0)
    rows.push([{ text: '上一頁', callback_data: `rp:${id}:${page - 1}` }]);
  if (offset + 6 < candidates.length)
    rows.push([{ text: '下一頁', callback_data: `rp:${id}:${page + 1}` }]);
  return rows;
}
export async function processReportCaseCallback(
  base: Context,
  update: TelegramUpdate,
  route: Route,
  client: TelegramClient,
) {
  await expireReportConversations(base.env.DB);
  const query = update.callback_query,
    match = /^(rc|rp):([a-f0-9]{32}):(\d{1,5})$/.exec(query?.data ?? '');
  const deny = async () => {
    if (query) await client.answerCallbackQuery(query.id, expiredText);
    return { code: 'CALLBACK_DENIED', reportId: null };
  };
  if (!match || !query) return deny();
  const conv = await base.env.DB.prepare(
    'SELECT * FROM telegram_report_conversations WHERE id=?',
  )
    .bind(match[2])
    .first<Conversation>();
  if (
    !conv ||
    conv.route_id !== route.id ||
    conv.collector_id !== route.collectorId ||
    conv.expires_at <= Date.now()
  )
    return deny();
  const candidates = JSON.parse(conv.candidates) as {
      id: string;
      assignment_id: string;
    }[],
    chosen = candidates[Number(match[3])];
  if (match[1] === 'rp') {
    if (conv.stage !== 'selecting') return deny();
    const page = Number(match[3]);
    if (page * 6 >= candidates.length) return deny();
    let ctx: Context;
    try {
      ctx = await principal(base, route, update);
    } catch {
      return deny();
    }
    const shown: Candidate[] = [];
    for (const candidate of candidates) {
      try {
        const c = await eligible(ctx, route, {
          ...conv,
          case_id: candidate.id,
          assignment_id: candidate.assignment_id,
        });
        if (!c) return deny();
        shown.push({
          id: c.id,
          assignment_id: candidate.assignment_id,
          code: c.code,
          customer_name: c.customerName,
          region: c.region,
        });
      } catch {
        return deny();
      }
    }
    await queueTelegramMessage(
      ctx,
      route,
      `report-candidate-page:${String(update.update_id)}`,
      '找到多筆同名案件，請選擇您要回報的案件：',
      null,
      {
        replyMarkup: {
          inline_keyboard: selectionKeyboard(conv.id, shown, page),
        },
      },
    );
    await client.answerCallbackQuery(query.id, '請選擇案件');
    return { code: 'AMBIGUOUS', reportId: null };
  }
  if (!chosen) return deny();
  if (
    conv.draft_content &&
    conv.case_id === chosen.id &&
    ['content', 'submitting'].includes(conv.stage)
  ) {
    return (
      (await processReportContent(
        base,
        {
          update_id: update.update_id,
          message: {
            message_id: query.message?.message_id ?? 1,
            date: query.message?.date ?? 0,
            chat: query.message?.chat ?? { id: Number(route.chatId) },
            message_thread_id: route.topicId ?? undefined,
            text: conv.draft_content,
          },
        },
        route,
      )) ?? deny()
    );
  }
  if (conv.stage !== 'selecting') {
    if (conv.stage === 'content' && conv.case_id === chosen.id) {
      try {
        const ctx = await principal(base, route, update);
        const record = await eligible(ctx, route, conv);
        if (!record) return deny();
        await queueTelegramMessage(
          ctx,
          route,
          `report-case-selected:${conv.id}`,
          `找到案件：\n${label({ id: record.id, assignment_id: chosen.assignment_id, code: record.code, customer_name: record.customerName, region: record.region })}\n\n請輸入回報內容：`,
        );
      } catch {
        return deny();
      }
      await client.answerCallbackQuery(
        query.id,
        '已選擇案件，請輸入回報內容。',
      );
      return { code: 'CASE_ALREADY_SELECTED', reportId: null };
    }
    return deny();
  }
  let ctx: Context;
  try {
    ctx = await principal(base, route, update);
    if (
      !(await eligible(ctx, route, {
        ...conv,
        case_id: chosen.id,
        assignment_id: chosen.assignment_id,
      }))
    )
      return deny();
  } catch {
    return deny();
  }
  const now = Date.now();
  const result = await base.env.DB.prepare(
    "UPDATE telegram_report_conversations SET stage='content',case_id=?,assignment_id=?,updated_at=? WHERE id=? AND stage='selecting' AND expires_at>? AND EXISTS(SELECT 1 FROM assignments a JOIN cases c ON c.id=a.case_id JOIN collectors col ON col.id=a.collector_id JOIN telegram_routes r ON r.id=telegram_report_conversations.route_id WHERE a.id=? AND a.collector_id=? AND a.unassigned_at IS NULL AND col.is_active=1 AND c.voided_at IS NULL AND r.is_active=1 AND r.collector_id=a.collector_id)",
  )
    .bind(
      chosen.id,
      chosen.assignment_id,
      now,
      conv.id,
      now,
      chosen.assignment_id,
      route.collectorId,
    )
    .run();
  if (result.meta.changes !== 1) return deny();
  if (conv.draft_content) {
    const result = await processReportContent(
      ctx,
      {
        update_id: update.update_id,
        message: {
          message_id: query.message?.message_id ?? 1,
          date: query.message?.date ?? 0,
          chat: query.message?.chat ?? { id: Number(route.chatId) },
          message_thread_id: route.topicId ?? undefined,
          text: conv.draft_content,
        },
      },
      route,
    );
    await client.answerCallbackQuery(query.id, '已選擇案件');
    return result ?? { code: 'CASE_SELECTION_REQUIRED', reportId: null };
  }
  const c = await base.env.DB.prepare(
    'SELECT code,customer_name,region FROM cases WHERE id=?',
  )
    .bind(chosen.id)
    .first<Candidate>();
  if (c)
    await queueTelegramMessage(
      ctx,
      route,
      `report-case-selected:${conv.id}`,
      `找到案件：\n${label(c)}\n\n請輸入回報內容：`,
    );
  await client.answerCallbackQuery(query.id, '已選擇案件');
  return { code: 'AWAITING_REPORT_CONTENT', reportId: null };
}
export async function processReportContent(
  base: Context,
  update: TelegramUpdate,
  route: Route,
) {
  const committed = await base.env.DB.prepare(
    'SELECT id,workflow_status FROM reports WHERE origin_key=? AND callback_route_id=?',
  )
    .bind(`telegram-update:${String(update.update_id)}`, route.id)
    .first<{ id: string; workflow_status: string }>();
  if (committed?.workflow_status === 'completed') {
    const ctx = await principal(base, route, update);
    await queueReportDestination(ctx, committed.id);
    return { code: 'REPORT_ALREADY_COMPLETED', reportId: committed.id };
  }
  const conv = await base.env.DB.prepare(
    "SELECT * FROM telegram_report_conversations WHERE route_id=? AND kind='report' AND stage IN ('selecting','content','submitting','status','expired') ORDER BY created_at DESC LIMIT 1",
  )
    .bind(route.id)
    .first<Conversation>();
  if (!conv) return null;
  const updateId = String(update.update_id),
    reply = (text: string) =>
      queueTelegramMessage(base, route, `command-reply:${updateId}`, text);
  if (conv.expires_at <= Date.now()) {
    await expireReportConversations(base.env.DB);
    await reply(expiredText);
    return { code: 'REPORT_DRAFT_EXPIRED', reportId: null };
  }
  if (conv.stage === 'status') {
    if (conv.content_update_id === updateId && conv.report_id) {
      await queueStatusPrompt(base, route, conv.report_id);
      return { code: 'REPORT_PENDING', reportId: conv.report_id };
    }
    return null;
  }
  if (conv.stage === 'selecting') {
    await reply('請先點選同名案件按鈕，或重新輸入 /回報 客戶姓名。');
    return { code: 'CASE_SELECTION_REQUIRED', reportId: null };
  }
  const content = update.message?.text?.trim() ?? '';
  if (!content || content.startsWith('/') || content.length > 3500) {
    await reply('請輸入回報內容（最多 3500 字），或重新輸入 /回報 客戶姓名。');
    return { code: 'INVALID_REPORT_CONTENT', reportId: null };
  }
  let ctx: Context, record: Awaited<ReturnType<typeof requireCaseAccess>>;
  try {
    ctx = await principal(base, route, update);
    const valid = await eligible(ctx, route, conv);
    if (!valid) throw new Error();
    record = valid;
  } catch {
    await reply('案件授權已變更，請重新輸入 /回報 客戶姓名。');
    return { code: 'CASE_DENIED', reportId: null };
  }
  const claim = await base.env.DB.prepare(
    "UPDATE telegram_report_conversations SET stage='submitting',content_update_id=?,updated_at=? WHERE id=? AND expires_at>? AND (stage='content' OR (stage='submitting' AND content_update_id=?))",
  )
    .bind(updateId, Date.now(), conv.id, Date.now(), updateId)
    .run();
  if (!claim.meta.changes)
    return {
      code: 'REPORT_CONTENT_ALREADY_RECEIVED',
      reportId: conv.report_id,
    };
  const report = await createReport(
    ctx,
    {
      caseId: record.id,
      expectedCaseVersion: record.version,
      content,
      status: 'needs_review',
      revisitStatus: null,
      revisitReason: null,
      paymentDetected: false,
      paymentAmount: null,
    },
    'telegram',
    `telegram-update:${updateId}`,
    {
      telegramUserId: `route:${route.id}`,
      routeId: route.id,
      receivedAt: conv.message_received_at ?? conv.created_at,
    },
  );
  await base.env.DB.prepare(
    "UPDATE telegram_report_conversations SET stage='status',report_id=?,updated_at=? WHERE id=? AND stage='submitting' AND content_update_id=?",
  )
    .bind(report.id, Date.now(), conv.id, updateId)
    .run();
  await queueStatusPrompt(ctx, route, report.id);
  await telegramAudit(
    ctx,
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
