import { ORPCError } from '@orpc/server';
import type { Context } from './context';

export type AuditAction =
  | 'case.created'
  | 'case.edited'
  | 'assignment.created'
  | 'assignment.reassigned'
  | 'assignment.unassigned'
  | 'media.uploaded'
  | 'media.deleted'
  | 'media.reordered'
  | 'collector.created'
  | 'collector.edited'
  | 'collector.activated'
  | 'collector.deactivated';
// Explicit allow-list: no free-form notes, names, addresses, credentials or image bytes.
export interface AuditMetadata {
  fields?: string[];
  mediaIds?: string[];
  collectorId?: string | null;
  previousCollectorId?: string | null;
  count?: number;
  version?: number;
}
export function auditStatement(
  context: Context,
  action: AuditAction,
  entityType: 'case' | 'collector',
  entityId: string,
  metadata: AuditMetadata,
  token?: string,
) {
  const table = entityType === 'case' ? 'cases' : 'collectors';
  const guard = token
    ? ` WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND write_token = ?)`
    : '';
  return context.env.DB.prepare(
    `INSERT INTO audit_logs (id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,?,?,?,?${guard}`,
  ).bind(
    crypto.randomUUID(),
    context.user?.id ?? null,
    action,
    entityType,
    entityId,
    JSON.stringify(metadata),
    Date.now(),
    ...(token ? [entityId, token] : []),
  );
}
export async function atomicCaseWrite(
  context: Context,
  statements: D1PreparedStatement[],
) {
  try {
    const results = await context.env.DB.batch(statements);
    if (results[0].meta.changes !== 1)
      throw new ORPCError('CONFLICT', {
        message: 'This record changed. Refresh and try again.',
      });
    return results;
  } catch (error: unknown) {
    if (error instanceof ORPCError) throw error;
    throw new ORPCError('CONFLICT', {
      message:
        'The operation could not be saved. Refresh and check the values.',
    });
  }
}
