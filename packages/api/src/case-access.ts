import { ORPCError } from '@orpc/server';
import { cases } from '@saasflare-dev/db';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { Context } from './context';
import {
  type Permission,
  permissionPolicy,
  requirePermission,
} from './permissions';

export function caseVisibility(
  context: Pick<Context, 'user' | 'isAdmin'>,
): SQL | undefined {
  if (!context.user) throw new ORPCError('UNAUTHORIZED');
  return permissionPolicy(context).scope === 'all'
    ? undefined
    : sql`EXISTS (SELECT 1 FROM assignments a JOIN collectors c ON c.id = a.collector_id WHERE a.case_id = ${cases.id} AND a.unassigned_at IS NULL AND c.is_active = 1 AND c.user_id = ${context.user.id})`;
}

export async function requireCaseAccess(
  context: Context,
  id: string,
  permission: Permission = 'case.view',
) {
  requirePermission(context, permission);
  const [record] = await context.DB.select()
    .from(cases)
    .where(and(eq(cases.id, id), caseVisibility(context)))
    .limit(1);
  // Identical response for unknown and inaccessible cases.
  if (!record) throw new ORPCError('NOT_FOUND');
  return record;
}
