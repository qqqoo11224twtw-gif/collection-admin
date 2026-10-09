import { ORPCError } from '@orpc/server';
import { authMode } from './auth';
import type { Context } from './context';
import { systemLog } from './system-log';

export const PERMISSIONS = [
  'case.view',
  'case.view_own',
  'case.view_all',
  'case.search',
  'case.delete',
  'assignment.bulk',
  'audit.view',
  'user_permission.manage',
  'system_log.view',
  'system_log.manage',
  'case.create',
  'case.edit',
  'assignment.create',
  'assignment.reassign',
  'media.view',
  'media.upload',
  'media.delete',
  'collector.manage',
  'audit_log.view',
  'report.view',
  'report.create',
  'report.edit',
  'review.view',
  'review.resolve',
  'intake.view',
  'intake.create',
  'intake.resolve',
  'intake.reject',
  'telegram_route.manage',
  'telegram_bot.manage',
  'installment.view',
  'installment.create',
  'installment.manage',
  'installment.cancel',
  'payment.view',
  'payment.create',
  'payment.void',
  'settlement.view',
  'settlement.mark_returned',
  'settlement.mark_pending',
  'finance.export',
  'assignment.correct',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
interface Policy {
  permissions: readonly Permission[];
  scope: 'all' | 'assigned';
}
// Central policy registry: additional roles/grants can be added without changing handlers.
export const ROLE_POLICIES: Record<string, Policy> = {
  admin: { permissions: PERMISSIONS, scope: 'all' },
  manager: {
    permissions: PERMISSIONS.filter(
      (permission) =>
        ![
          'collector.manage',
          'user_permission.manage',
          'telegram_bot.manage',
        ].includes(permission),
    ),
    scope: 'all',
  },
  user: {
    permissions: [
      'case.view',
      'case.view_own',
      'case.search',
      'media.view',
      'report.view',
      'report.create',
      'intake.view',
      'intake.create',
      'installment.view',
      'installment.create',
      'payment.view',
      'payment.create',
    ],
    scope: 'assigned',
  },
  reviewer: {
    permissions: [
      'case.view',
      'case.edit',
      'report.view',
      'report.edit',
      'review.view',
      'review.resolve',
    ],
    scope: 'assigned',
  },
  finance: {
    permissions: [
      'case.view',
      'case.view_all',
      'case.search',
      'payment.view',
      'payment.create',
      'payment.void',
      'settlement.view',
      'settlement.mark_returned',
      'settlement.mark_pending',
      'finance.export',
      'installment.view',
    ],
    scope: 'all',
  },
};
export function permissionPolicy(
  context: Pick<Context, 'user' | 'telegramCollectorId'>,
): Policy {
  if (!context.user) return { permissions: [], scope: 'assigned' };
  const defaults = ROLE_POLICIES[context.user.role ?? 'user'] ?? {
    permissions: [],
    scope: 'assigned',
  };
  const grants = parseGrants(context.user.permissionAllow);
  const deny = parseGrants(context.user.permissionDeny);
  const effective = new Set<Permission>([...defaults.permissions, ...grants]);
  if (defaults.scope === 'all') effective.add('case.view_all');
  else if (effective.has('case.view')) effective.add('case.view_own');
  if (effective.has('audit_log.view')) effective.add('audit.view');
  if (effective.has('audit.view')) effective.add('audit_log.view');
  for (const key of deny) effective.delete(key);
  if (deny.includes('audit.view')) effective.delete('audit_log.view');
  if (deny.includes('audit_log.view')) effective.delete('audit.view');
  if (effective.has('case.view_all') || effective.has('case.view_own'))
    effective.add('case.view');
  else effective.delete('case.view');
  if (deny.includes('case.view')) {
    effective.delete('case.view');
    effective.delete('case.view_all');
    effective.delete('case.view_own');
  }
  return {
    permissions: [...effective],
    scope:
      !context.telegramCollectorId && effective.has('case.view_all')
        ? 'all'
        : 'assigned',
  };
}
export function parseGrants(raw?: string): Permission[] {
  try {
    const data: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(data)
      ? data.filter(
          (p): p is Permission =>
            typeof p === 'string' && PERMISSIONS.includes(p as Permission),
        )
      : [];
  } catch {
    return [];
  }
}
export function requirePermission(context: Context, permission: Permission) {
  if (authMode() === 'disabled' || !context.user || !context.session)
    throw new ORPCError('UNAUTHORIZED');
  if (!permissionPolicy(context).permissions.includes(permission)) {
    const log = systemLog(context.env.DB, {
      category: 'permission',
      event: 'PERMISSION_DENIED',
      level: 'warning',
      status: 'denied',
      relatedUserId: context.user.id,
      correlationId: context.correlationId,
      errorCode: 'PERMISSION_DENIED',
      safeMessage: `無操作權限：${permission}`,
    });
    context.defer?.(log);
    throw new ORPCError('FORBIDDEN');
  }
  return context.user;
}
