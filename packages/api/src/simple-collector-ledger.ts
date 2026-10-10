import type { Context } from './context';

/** Immutable customer payments, offsets and cash remittances are distinct events.
 * Deprecated fee snapshots and allocation components never enter this ledger. */
export type CollectorLedgerRow = {
  id: string;
  collector_id: string | null;
  collector_name: string | null;
  case_id: string | null;
  payment_id: string | null;
  received_date: string;
  created_at: number;
  code: string;
  customer_name: string;
  type: 'payment' | 'offset' | 'remittance';
  actual_received: number;
  return_due: number;
  returned_amount: number;
  marker: string;
  note: string;
  pending: number;
};
export async function collectorLedger(context: Context, collectorId?: string) {
  const rows =
    await context.env.DB.prepare(`SELECT e.*,c.display_name collector_name FROM (
    SELECT p.id,s.collector_id,s.case_id,p.id payment_id,p.received_date,p.created_at,
      s.agent_code_snapshot code,s.customer_name_snapshot customer_name,'payment' type,
      p.received_amount actual_received,s.principal_return_due_from_collector return_due,
      0 returned_amount,
      '0' marker,'' note,
      max(0,s.principal_return_due_from_collector-coalesce((SELECT sum(a.amount) FROM remittance_allocations a JOIN remittances r ON r.id=a.remittance_id
        WHERE a.settlement_id=s.id AND a.component='principal' AND r.voided_at IS NULL),0)) pending
    FROM payments p JOIN settlements s ON s.payment_id=p.id WHERE p.status='received' AND p.channel='collector_received'
    UNION ALL
    SELECT o.id,o.collector_id,p.case_id,p.id,p.received_date,o.created_at,
      s.agent_code_snapshot,s.customer_name_snapshot,'offset',0,-o.amount,0,'後結','',0
    FROM collector_offsets o JOIN payments p ON p.id=o.source_payment_id JOIN settlements s ON s.payment_id=p.id
    WHERE o.voided_at IS NULL AND p.status='received' AND p.channel='direct_to_principal'
    UNION ALL
    SELECT r.id,r.collector_id,NULL,NULL,r.received_date,r.created_at,'回帳','回帳','remittance',0,-r.amount,r.amount,'已回帳',r.note,0
    FROM remittances r WHERE r.voided_at IS NULL
  ) e LEFT JOIN collectors c ON c.id=e.collector_id ${collectorId ? 'WHERE e.collector_id=?' : ''}
  ORDER BY e.received_date,e.created_at,e.id`)
      .bind(...(collectorId ? [collectorId] : []))
      .all<CollectorLedgerRow>();
  return rows.results;
}
export function summarizeCollectorLedger(rows: CollectorLedgerRow[]) {
  const total = rows.reduce(
    (sum, row) => ({
      actualReceived: sum.actualReceived + row.actual_received,
      returnDue: sum.returnDue + (row.type === 'payment' ? row.return_due : 0),
      offset: sum.offset + (row.type === 'offset' ? -row.return_due : 0),
      remitted:
        sum.remitted + (row.type === 'remittance' ? -row.return_due : 0),
    }),
    { actualReceived: 0, returnDue: 0, offset: 0, remitted: 0 },
  );
  return {
    ...total,
    netReturnDue: total.returnDue - total.offset - total.remitted,
  };
}
