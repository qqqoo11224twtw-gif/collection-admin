import { z } from 'zod';
import { financeCollectorScope } from './collector-finance';
import type { Context } from './context';
import { businessToday } from './finance-contract';
import { protectedProcedure } from './middleware';
import {
  collectorLedger,
  summarizeCollectorLedger,
} from './simple-collector-ledger';

// Payout and fee APIs are retired; their historical DB rows are preserved for audit.
export async function clearingOverview(
  context: Context,
  raw?: { collectorId?: string },
) {
  const scope = await financeCollectorScope(context, raw?.collectorId);
  const ledger = await collectorLedger(context, scope);
  return {
    businessDate: businessToday(
      new Date(),
      context.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
    ),
    summary: summarizeCollectorLedger(ledger),
  };
}
export const clearingApi = {
  overview: protectedProcedure
    .input(z.strictObject({ collectorId: z.string().optional() }).default({}))
    .handler(({ context, input }) => clearingOverview(context, input)),
};
