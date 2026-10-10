import type { Context } from './context';

/** Actual customer receipts are exclusively derived from valid payment events. */
export async function customerPaymentSummary(context: Context, caseId: string) {
  const payments = (
    await context.env.DB.prepare(
      "SELECT id,received_amount,received_date,channel FROM payments WHERE case_id=? AND status='received' ORDER BY received_date,created_at,id",
    )
      .bind(caseId)
      .all<{
        id: string;
        received_amount: number;
        received_date: string;
        channel: string;
      }>()
  ).results;
  const allocations = await context.env.DB.prepare(
    "SELECT coalesce(sum(a.amount),0) AS amount FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE p.case_id=? AND p.status='received'",
  )
    .bind(caseId)
    .first<{ amount: number }>();
  const actualReceived = payments.reduce(
    (total, payment) => total + payment.received_amount,
    0,
  );
  return {
    actualReceived,
    allocatedAmount: allocations?.amount ?? 0,
    unappliedAmount: actualReceived - (allocations?.amount ?? 0),
    payments,
  };
}

export async function renderPaymentBusinessReport(
  context: Context,
  input: {
    caseId: string;
    paymentId: string;
    code: string;
    customerName: string;
    content: string;
    date: string;
  },
) {
  const summary = await customerPaymentSummary(context, input.caseId);
  const current = summary.payments.find(
    (payment) => payment.id === input.paymentId,
  );
  if (!current) throw Error('PAYMENT_MISSING');
  const oneLine = (value: string) =>
    Array.from(value, (c) =>
      c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c,
    ).join('');
  return `代理：${oneLine(input.code)}\n客戶姓名：${oneLine(input.customerName)}\n回報內容：已收款 ${current.received_amount}\n收款紀錄：\n${summary.payments.map((payment) => `${payment.received_date.slice(5).replace('-', '/')} ${payment.received_amount}`).join('\n')}\n累計已收：${summary.actualReceived}`;
}
