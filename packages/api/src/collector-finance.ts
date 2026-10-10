import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import { atomicCaseWrite } from './audit';
import type { Context } from './context';
import { businessToday, dateSchema, moneySchema } from './finance-contract';
import { financialWorkbook } from './finance-export';
import { protectedProcedure } from './middleware';
import { permissionPolicy, requirePermission } from './permissions';
import {
  collectorLedger,
  summarizeCollectorLedger,
} from './simple-collector-ledger';

export const collectorFinanceRange = z
  .strictObject({
    collectorId: z.string().min(1).max(128).optional(),
    dateFrom: dateSchema.optional(),
    dateTo: dateSchema.optional(),
    page: z.number().int().min(1).max(100000).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
    status: z.enum(['all', 'pending', 'returned']).default('all'),
    query: z.string().trim().max(100).default(''),
  })
  .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo);
export const rateSettingsSchema = z.strictObject({
  collectorId: z.string().min(1).max(128),
  kind: z.literal('return'),
  rate: z
    .number()
    .min(0)
    .max(1)
    .refine((v) => Math.abs(v * 10000 - Math.round(v * 10000)) < 1e-8),
  expectedVersion: z.number().int().nonnegative(),
});
export const remittanceCreateSchema = z.strictObject({
  collectorId: z.string().min(1).max(128),
  idempotencyKey: z.string().uuid(),
  amount: moneySchema,
  receivedDate: dateSchema,
  note: z.string().trim().max(500).default(''),
});
export const eventVoidSchema = z.strictObject({
  id: z.string().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
});
export type FinanceSettings = {
  version: number;
};
export async function readFinanceSettings(context: Context) {
  const settings = await context.env.DB.prepare(
    "SELECT version FROM finance_settings WHERE id='global'",
  ).first<FinanceSettings>();
  if (!settings)
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: '財務設定尚未初始化。',
    });
  return settings;
}

export async function financeCollectorScope(
  context: Context,
  requested?: string,
) {
  requirePermission(context, 'settlement.view');
  if (
    context.user?.role !== 'user' &&
    permissionPolicy(context).scope === 'all'
  )
    return requested;
  const rows = await context.env.DB.prepare(
    'SELECT id FROM collectors WHERE user_id=?',
  )
    .bind(context.user?.id)
    .all<{ id: string }>();
  // An ambiguous website binding must not broaden financial visibility.
  if (
    rows.results.length !== 1 ||
    (requested && rows.results[0].id !== requested)
  )
    throw new ORPCError('FORBIDDEN');
  return rows.results[0].id;
}
type Obligation = { id: string; return_amount: number; principal_paid: number };
async function obligationRows(context: Context, collectorId: string) {
  return (
    await context.env.DB.prepare(
      "SELECT s.id,s.principal_return_due_from_collector return_amount,coalesce((SELECT sum(a.amount) FROM remittance_allocations a JOIN remittances r ON r.id=a.remittance_id WHERE a.settlement_id=s.id AND a.component='principal' AND r.voided_at IS NULL),0) principal_paid FROM settlements s JOIN payments p ON p.id=s.payment_id WHERE s.collector_id=? AND p.status='received' AND p.channel='collector_received' ORDER BY s.received_date,s.created_at,s.id",
    )
      .bind(collectorId)
      .all<Obligation>()
  ).results;
}
function allocateObligations(rows: Obligation[], amount: number) {
  let remaining = amount;
  const allocations: {
    settlementId: string;
    component: 'principal';
    amount: number;
  }[] = [];
  for (const row of rows) {
    const take = Math.min(
      remaining,
      Math.max(0, row.return_amount - row.principal_paid),
    );
    if (take > 0)
      allocations.push({
        settlementId: row.id,
        component: 'principal',
        amount: take,
      });
    remaining -= take;
    if (!remaining) break;
  }
  return allocations; // excess is a real advance remittance, never rejected
}
export function financialEventAudit(
  context: Context,
  action: string,
  entityId: string,
  metadata: Record<string, string | number | null>,
  token: string,
) {
  return context.env.DB.prepare(
    "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,'finance',?,?,? WHERE EXISTS(SELECT 1 FROM finance_settings WHERE id='global' AND write_token=?)",
  ).bind(
    crypto.randomUUID(),
    context.user?.id ?? null,
    action,
    entityId,
    JSON.stringify(metadata),
    Date.now(),
    token,
  );
}
export async function createRemittance(context: Context, raw: unknown) {
  const actor = requirePermission(context, 'settlement.mark_returned');
  const input = remittanceCreateSchema.parse(raw);
  const scope = await financeCollectorScope(context, input.collectorId);
  if (!scope) throw new ORPCError('FORBIDDEN');
  if (input.receivedDate > businessToday()) throw new ORPCError('BAD_REQUEST');
  const replay = async () => {
    const prior = await context.env.DB.prepare(
      'SELECT id,collector_id,amount,received_date,note,voided_at FROM remittances WHERE idempotency_key=?',
    )
      .bind(input.idempotencyKey)
      .first<{
        id: string;
        collector_id: string;
        amount: number;
        received_date: string;
        note: string;
        voided_at: number | null;
      }>();
    if (!prior) return null;
    if (
      prior.collector_id !== scope ||
      prior.amount !== input.amount ||
      prior.received_date !== input.receivedDate ||
      prior.note !== input.note ||
      prior.voided_at !== null
    )
      throw new ORPCError('CONFLICT');
    return { id: prior.id, duplicate: true };
  };
  const prior = await replay();
  if (prior) return prior;
  const settings = await readFinanceSettings(context);
  const allocation = allocateObligations(
    await obligationRows(context, scope),
    input.amount,
  );
  const token = crypto.randomUUID(),
    id = crypto.randomUUID(),
    now = Date.now();
  try {
    await atomicCaseWrite(context, [
      context.env.DB.prepare(
        "UPDATE finance_settings SET version=version+1,write_token=?,updated_at=? WHERE id='global' AND version=? AND NOT EXISTS(SELECT 1 FROM remittances WHERE idempotency_key=?)",
      ).bind(token, now, settings.version, input.idempotencyKey),
      context.env.DB.prepare(
        'INSERT INTO remittances(id,idempotency_key,collector_id,amount,principal_amount,commission_amount,received_date,note,created_by_user_id,created_at,write_token) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM finance_settings WHERE write_token=?)',
      ).bind(
        id,
        input.idempotencyKey,
        scope,
        input.amount,
        input.amount,
        0,
        input.receivedDate,
        input.note,
        actor.id,
        now,
        token,
        token,
      ),
      ...allocation.map((a) =>
        context.env.DB.prepare(
          'INSERT INTO remittance_allocations(id,remittance_id,settlement_id,component,amount) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM remittances WHERE id=? AND write_token=?)',
        ).bind(
          crypto.randomUUID(),
          id,
          a.settlementId,
          a.component,
          a.amount,
          id,
          token,
        ),
      ),
      financialEventAudit(
        context,
        'remittance.created',
        id,
        {
          collectorId: scope,
          amount: input.amount,
          receivedDate: input.receivedDate,
        },
        token,
      ),
    ]);
  } catch (error) {
    const duplicate = await replay();
    if (duplicate) return duplicate;
    throw error;
  }
  return { id, duplicate: false };
}
export async function voidFinancialEvent(
  context: Context,
  raw: unknown,
  kind: 'remittance' | 'offset',
) {
  const actor = requirePermission(context, 'settlement.mark_pending');
  const input = eventVoidSchema.parse(raw);
  const table = kind === 'remittance' ? 'remittances' : 'collector_offsets';
  const row = await context.env.DB.prepare(
    `SELECT collector_id,voided_at FROM ${table} WHERE id=?`,
  )
    .bind(input.id)
    .first<{
      collector_id: string;
      voided_at: number | null;
    }>();
  if (!row) throw new ORPCError('NOT_FOUND');
  await financeCollectorScope(context, row.collector_id);
  if (row.voided_at !== null) return { id: input.id, duplicate: true };
  const settings = await readFinanceSettings(context),
    token = crypto.randomUUID(),
    now = Date.now();
  await atomicCaseWrite(context, [
    context.env.DB.prepare(
      `UPDATE finance_settings SET version=version+1,write_token=?,updated_at=? WHERE id='global' AND version=? AND EXISTS(SELECT 1 FROM ${table} WHERE id=? AND voided_at IS NULL)`,
    ).bind(token, now, settings.version, input.id),
    context.env.DB.prepare(
      `UPDATE ${table} SET voided_at=?,voided_by_user_id=?,void_reason=? WHERE id=? AND voided_at IS NULL AND EXISTS(SELECT 1 FROM finance_settings WHERE write_token=?)`,
    ).bind(now, actor.id, input.reason, input.id, token),
    financialEventAudit(
      context,
      `${kind}.voided`,
      input.id,
      { collectorId: row.collector_id },
      token,
    ),
  ]);
  return { id: input.id, duplicate: false };
}
export async function collectorFinanceReport(
  context: Context,
  raw: unknown,
  exporting = false,
) {
  const input = collectorFinanceRange.parse(raw);
  const collectorId = await financeCollectorScope(context, input.collectorId);
  const rows = (await collectorLedger(context, collectorId)).filter(
    (row) =>
      (!input.dateFrom || row.received_date >= input.dateFrom) &&
      (!input.dateTo || row.received_date <= input.dateTo) &&
      (!input.query ||
        row.code.includes(input.query) ||
        row.customer_name.includes(input.query)) &&
      (input.status === 'all' ||
        (input.status === 'pending'
          ? row.type === 'payment' && row.pending > 0
          : row.type === 'remittance' ||
            (row.type === 'payment' && row.pending === 0))),
  );
  return {
    collectorId: collectorId ?? null,
    summary: summarizeCollectorLedger(rows),
    items: exporting
      ? rows
      : rows.slice(
          (input.page - 1) * input.pageSize,
          input.page * input.pageSize,
        ),
    total: rows.length,
    page: input.page,
    pageSize: input.pageSize,
  };
}
export async function exportCollectorLedger(context: Context, raw: unknown) {
  const input = collectorFinanceRange.parse(raw);
  requirePermission(context, 'finance.export');
  const version = (await readFinanceSettings(context)).version;
  const result = await collectorFinanceReport(context, input, true);
  if (result.total > 5000)
    throw new ORPCError('BAD_REQUEST', {
      message: '請縮小日期範圍，最多匯出 5000 筆。',
    });
  const items = [...result.items];
  if ((await readFinanceSettings(context)).version !== version)
    throw new ORPCError('CONFLICT', {
      message: '匯出期間財務資料已更新，請重新匯出。',
    });
  const data: (string | number)[][] = [
    ['日期', '代理', '會員名稱', '實際收款', '應回帳', '已回帳', '備註'],
    ...items.map((r) => [
      r.received_date,
      r.code,
      r.customer_name,
      r.actual_received,
      r.return_due,
      r.type === 'payment' ? r.returned_amount : r.marker,
      r.note,
    ]),
    [],
    ['總實際收款', result.summary.actualReceived],
    ['總應回帳', result.summary.returnDue],
    ['總後結金額', result.summary.offset],
    ['總回帳金額', result.summary.remitted],
    ['實際應回款', result.summary.netReturnDue],
  ];
  await context.env.DB.prepare(
    "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) VALUES(?,?,'finance.collector_exported','finance',?,'{}',?)",
  )
    .bind(
      crypto.randomUUID(),
      context.user?.id,
      crypto.randomUUID(),
      Date.now(),
    )
    .run();
  return {
    filename: 'collector-settlements.xlsx',
    bytes: Array.from(financialWorkbook(data)),
  };
}
export const collectorFinanceApi = {
  export: protectedProcedure
    .input(collectorFinanceRange)
    .handler(({ context, input }) => exportCollectorLedger(context, input)),
  collectors: protectedProcedure.handler(async ({ context }) => {
    const own = await financeCollectorScope(context);
    return (
      await context.env.DB.prepare(
        `SELECT id,display_name,code,is_active FROM collectors${own ? ' WHERE id=?' : ''} ORDER BY display_name,id`,
      )
        .bind(...(own ? [own] : []))
        .all<{
          id: string;
          display_name: string;
          code: string;
          is_active: number;
        }>()
    ).results;
  }),
  report: protectedProcedure
    .input(collectorFinanceRange)
    .handler(({ context, input }) => collectorFinanceReport(context, input)),
  settings: protectedProcedure
    .input(z.strictObject({ kind: z.literal('return').optional() }).default({}))
    .handler(({ context, input }) => collectorSettings(context, input.kind)),
  setRate: protectedProcedure
    .input(rateSettingsSchema)
    .handler(({ context, input }) => changeCollectorRate(context, input)),
  deleteRate: protectedProcedure
    .input(
      z.strictObject({
        collectorId: z.string().min(1).max(128),
        kind: z.literal('return'),
        expectedVersion: z.number().int().nonnegative(),
      }),
    )
    .handler(({ context, input }) =>
      changeCollectorRate(context, { ...input, rate: null }),
    ),
  createRemittance: protectedProcedure
    .input(remittanceCreateSchema)
    .handler(({ context, input }) => createRemittance(context, input)),
  voidRemittance: protectedProcedure
    .input(eventVoidSchema)
    .handler(({ context, input }) =>
      voidFinancialEvent(context, input, 'remittance'),
    ),
  voidOffset: protectedProcedure
    .input(eventVoidSchema)
    .handler(({ context, input }) =>
      voidFinancialEvent(context, input, 'offset'),
    ),
};

export const missingCollectorRatesMessage =
  '此外收尚未完成財務比例設定，請先至財務設定完成設定。';
export async function readCollectorRates(
  context: Context,
  collectorId: string | null,
) {
  if (!collectorId)
    throw new ORPCError('BAD_REQUEST', {
      message: missingCollectorRatesMessage,
    });
  const ret = await context.env.DB.prepare(
    "SELECT id,return_rate AS rate FROM collector_finance_settings WHERE collector_id=? AND kind='return' AND active=1",
  )
    .bind(collectorId)
    .first<{ id: string; rate: number }>();
  if (!ret || !rateSettingsSchema.shape.rate.safeParse(ret.rate).success)
    throw new ORPCError('BAD_REQUEST', {
      message: missingCollectorRatesMessage,
    });
  return { returnRate: ret.rate, returnId: ret.id };
}
async function changeCollectorRate(
  context: Context,
  input: {
    collectorId: string;
    kind: 'return';
    rate: number | null;
    expectedVersion: number;
  },
) {
  const actor = requirePermission(context, 'finance.return_rate.manage');
  if (permissionPolicy(context).scope !== 'all')
    throw new ORPCError('FORBIDDEN');
  const collector = await context.env.DB.prepare(
    'SELECT id FROM collectors WHERE id=?',
  )
    .bind(input.collectorId)
    .first();
  if (!collector) throw new ORPCError('NOT_FOUND');
  const old = await context.env.DB.prepare(
    'SELECT id,return_rate AS rate FROM collector_finance_settings WHERE collector_id=? AND kind=? AND active=1',
  )
    .bind(input.collectorId, input.kind)
    .first<{ id: string; rate: number }>();
  if (input.rate === null && !old) throw new ORPCError('NOT_FOUND');
  const now = Date.now(),
    token = crypto.randomUUID(),
    id = crypto.randomUUID();
  const action = `COLLECTOR_RETURN_RATE_${input.rate === null ? 'DELETED' : old ? 'UPDATED' : 'CREATED'}`;
  await atomicCaseWrite(context, [
    context.env.DB.prepare(
      "UPDATE finance_settings SET version=version+1,write_token=?,updated_at=? WHERE id='global' AND version=?",
    ).bind(token, now, input.expectedVersion),
    context.env.DB.prepare(
      "UPDATE collector_finance_settings SET active=0,effective_to=?,updated_at=?,updated_by=? WHERE collector_id=? AND kind=? AND active=1 AND EXISTS(SELECT 1 FROM finance_settings WHERE id='global' AND write_token=?)",
    ).bind(now, now, actor.id, input.collectorId, input.kind, token),
    ...(input.rate === null
      ? []
      : [
          context.env.DB.prepare(
            "INSERT INTO collector_finance_settings(id,collector_id,kind,rate,return_rate,commission_rate,active,effective_from,created_by,created_at,updated_by,updated_at) SELECT ?,?,?,?,?,?,1,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM finance_settings WHERE id='global' AND write_token=?)",
          ).bind(
            id,
            input.collectorId,
            input.kind,
            input.rate,
            input.kind === 'return' ? input.rate : null,
            null,
            now,
            actor.id,
            now,
            actor.id,
            now,
            token,
          ),
        ]),
    financialEventAudit(
      context,
      action,
      input.collectorId,
      {
        collector_id: input.collectorId,
        old_rate: old?.rate ?? null,
        new_rate: input.rate,
        operator: actor.id,
        timestamp: now,
      },
      token,
    ),
  ]);
  return { id, rate: input.rate };
}

async function collectorSettings(context: Context, _kind?: 'return') {
  requirePermission(context, 'finance.return_rate.manage');
  if (permissionPolicy(context).scope !== 'all')
    throw new ORPCError('FORBIDDEN');
  requirePermission(context, 'settlement.view');
  const revision = await readFinanceSettings(context);
  const items = (
    await context.env.DB.prepare(
      "SELECT s.id,s.collector_id,s.kind,s.return_rate AS rate,s.updated_at,s.effective_from,c.display_name FROM collector_finance_settings s JOIN collectors c ON c.id=s.collector_id WHERE s.active=1 AND s.kind='return' ORDER BY c.display_name,s.id",
    ).all<{
      id: string;
      collector_id: string;
      display_name: string;
      kind: 'return';
      rate: number;
      updated_at: number;
      effective_from: number;
    }>()
  ).results;
  return { version: revision.version, items };
}
