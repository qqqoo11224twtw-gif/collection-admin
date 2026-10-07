import { ORPCError } from '@orpc/server';
import { authMode } from './auth';
import type { Context } from './context';

export const PERMISSIONS = [
  'case.view',
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
] as const;
export type Permission = (typeof PERMISSIONS)[number];
interface Policy {
  permissions: readonly Permission[];
  scope: 'all' | 'assigned';
}
// Central policy registry: additional roles/grants can be added without changing handlers.
const ROLE_POLICIES: Record<string, Policy> = {
  admin: { permissions: PERMISSIONS, scope: 'all' },
  manager: {
    permissions: PERMISSIONS.filter(
      (permission) => permission !== 'collector.manage',
    ),
    scope: 'all',
  },
  user: {
    permissions: ['case.view', 'media.view', 'report.view', 'report.create'],
    scope: 'assigned',
  },
};
export function permissionPolicy(context: Pick<Context, 'user'>): Policy {
  if (!context.user) return { permissions: [], scope: 'assigned' };
  return (
    ROLE_POLICIES[context.user.role ?? 'user'] ?? {
      permissions: [],
      scope: 'assigned',
    }
  );
}
export function requirePermission(context: Context, permission: Permission) {
  if (authMode() === 'disabled' || !context.user || !context.session)
    throw new ORPCError('UNAUTHORIZED');
  if (!permissionPolicy(context).permissions.includes(permission))
    throw new ORPCError('FORBIDDEN');
  return context.user;
}
