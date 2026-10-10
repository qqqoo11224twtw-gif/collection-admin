import { z } from 'zod';

export const moneySchema = z.number().int().positive().max(1_000_000_000_000);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= '2000-01-01' &&
      value <= '2100-12-31'
    );
  }, 'Use a valid calendar date between 2000 and 2100.');
const planCommon = {
  caseId: z.string().min(1).max(128),
  reportId: z.string().min(1).max(128).nullable().default(null),
  totalAmount: moneySchema,
};
export const planCreateSchema = z
  .discriminatedUnion('planType', [
    z
      .object({
        ...planCommon,
        planType: z.literal('deadline'),
        deadlineDate: dateSchema,
      })
      .strict(),
    z
      .object({
        ...planCommon,
        planType: z.literal('weekly'),
        weekday: z.number().int().min(1).max(7),
        perPaymentAmount: moneySchema,
        firstPaymentDate: dateSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...planCommon,
        planType: z.literal('monthly'),
        dayOfMonth: z.number().int().min(1).max(31),
        perPaymentAmount: moneySchema,
        firstPaymentDate: dateSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...planCommon,
        planType: z.literal('custom'),
        schedules: z
          .array(
            z
              .object({ dueDate: dateSchema, expectedAmount: moneySchema })
              .strict(),
          )
          .min(1)
          .max(240),
      })
      .strict(),
  ])
  .refine(
    (input) =>
      input.planType === 'deadline' ||
      input.planType === 'custom' ||
      input.perPaymentAmount <= input.totalAmount,
    'Per-payment amount must not exceed the total.',
  )
  .refine(
    (input) =>
      input.planType === 'deadline' ||
      input.planType === 'custom' ||
      Math.ceil(input.totalAmount / input.perPaymentAmount) <= 240,
    'At most 240 payments per plan.',
  );
export type PlanInput = z.infer<typeof planCreateSchema>;
export const paymentCreateSchema = z
  .object({
    caseId: z.string().min(1).max(128),
    idempotencyKey: z.string().uuid(),
    installmentScheduleId: z.string().min(1).max(128).nullable().default(null),
    receivedDate: dateSchema,
    receivedAmount: moneySchema,
  })
  .strict();
export const financeRangeSchema = z
  .object({
    dateFrom: dateSchema.optional(),
    dateTo: dateSchema.optional(),
    page: z.number().int().min(1).max(100000).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine(
    (input) =>
      !input.dateFrom || !input.dateTo || input.dateFrom <= input.dateTo,
    'Start date must precede end date.',
  );
export const ledgerVersionSchema = z
  .object({
    id: z.string().min(1).max(128),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export const settlementStateSchema = ledgerVersionSchema
  .extend({ returnStatus: z.enum(['pending', 'returned']) })
  .strict();

export function businessToday(now = new Date(), timezone = 'Asia/Taipei') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}-${parts.find((p) => p.type === 'day')?.value}`;
}
export function calculatePrincipalSplit(amount: number, returnRate: number) {
  const rate = 1 - returnRate;
  moneySchema.parse(amount);
  const bp = Math.round(rate * 10000);
  if (
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate > 1 ||
    Math.abs(rate - bp / 10000) > 1e-10
  )
    throw new Error('INVALID_RETURN_RATE');
  const collectorShare = Number((BigInt(amount) * BigInt(bp) + 5000n) / 10000n);
  return {
    collectorShareRate: bp / 10000,
    collectorShare,
    principalDue: amount - collectorShare,
  };
}
export function generateSchedule(raw: PlanInput, today = businessToday()) {
  const input = planCreateSchema.parse(raw);
  dateSchema.parse(today);
  if (input.planType === 'custom') {
    if (
      input.schedules.some((s) => s.dueDate < today) ||
      input.schedules.reduce((sum, s) => sum + s.expectedAmount, 0) !==
        input.totalAmount
    )
      throw new Error('INVALID_CUSTOM_SCHEDULE');
    return [...input.schedules]
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((s, index) => ({ ...s, sequence: index + 1 }));
  }
  const format = (date: Date) => date.toISOString().slice(0, 10);
  if (input.planType === 'deadline') {
    if (input.deadlineDate < today) throw new Error('DEADLINE_IN_PAST');
    return [
      {
        sequence: 1,
        dueDate: input.deadlineDate,
        expectedAmount: input.totalAmount,
      },
    ];
  }
  let remaining = input.totalAmount;
  const first = input.firstPaymentDate ?? today;
  if (first < today) throw new Error('FIRST_DATE_IN_PAST');
  const start = new Date(`${first}T00:00:00Z`);
  let due = new Date(start);
  let month = start.getUTCMonth(),
    year = start.getUTCFullYear();
  if (input.planType === 'weekly')
    due.setUTCDate(
      start.getUTCDate() + ((input.weekday - (start.getUTCDay() || 7) + 7) % 7),
    );
  const rows = [];
  while (remaining > 0) {
    if (input.planType === 'monthly') {
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      due = new Date(Date.UTC(year, month, Math.min(input.dayOfMonth, last)));
      if (format(due) < first) {
        month++;
        continue;
      }
    }
    const amount = Math.min(remaining, input.perPaymentAmount);
    const dueDate = format(due);
    dateSchema.parse(dueDate);
    rows.push({ sequence: rows.length + 1, dueDate, expectedAmount: amount });
    remaining -= amount;
    if (input.planType === 'weekly') due.setUTCDate(due.getUTCDate() + 7);
    else month++;
  }
  return rows;
}
