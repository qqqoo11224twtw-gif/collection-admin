import { ORPCError } from '@orpc/server';
import { cases } from '@saasflare-dev/db';
import { and, eq, type SQL } from 'drizzle-orm';
import type { Context } from './context';

export function caseVisibility(
  context: Pick<Context, 'user' | 'isAdmin'>,
): SQL | undefined {
  if (!context.user) throw new ORPCError('UNAUTHORIZED');
  return context.isAdmin
    ? undefined
    : eq(cases.assignedAgentId, context.user.id);
}

export async function requireCaseAccess(context: Context, id: string) {
  const [record] = await context.DB.select()
    .from(cases)
    .where(and(eq(cases.id, id), caseVisibility(context)))
    .limit(1);
  // Identical response for unknown and inaccessible cases.
  if (!record) throw new ORPCError('NOT_FOUND');
  return record;
}
