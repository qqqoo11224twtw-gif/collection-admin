import type { Context } from './context';

export function financeAudit(
  context: Context,
  caseId: string,
  action: string,
  entityId: string,
  guard?: { sql: string; values: (string | number | null)[] },
) {
  return context.env.DB.prepare(
    `INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,'case',?,?,?${guard ? ` WHERE ${guard.sql}` : ''}`,
  ).bind(
    crypto.randomUUID(),
    context.user?.id ?? null,
    action,
    caseId,
    JSON.stringify({ entityId }),
    Date.now(),
    ...(guard?.values ?? []),
  );
}
