import { ORPCError, os } from '@orpc/server';
import { authMode } from './auth';
import type { Context } from './context';

const o = os.$context<Context>();

/** No identity required. Health checks, config probe, read-only demo data. */
export const publicProcedure = o;

/**
 * Requires a logged-in user; narrows `session`/`user` to non-null.
 *
 * In `disabled` mode this always throws AUTH_DISABLED (401): the fail-closed
 * backstop. A product that runs disabled should DELETE its unused protected
 * routes — this fuse only guarantees a forgotten one is unreachable, not
 * that it belongs in the router.
 */
export const protectedProcedure = o.use(({ context, next }) => {
  if (authMode() === 'disabled') {
    throw new ORPCError('AUTH_DISABLED', {
      status: 401,
      message: 'This deployment runs with AUTH_MODE=disabled.',
    });
  }
  const { session, user } = context;
  if (!session || !user) throw new ORPCError('UNAUTHORIZED');
  return next({ context: { ...context, session, user } });
});

/** Requires a logged-in admin (`user.role === 'admin'`). */
export const adminProcedure = protectedProcedure.use(({ context, next }) => {
  if (!context.isAdmin) throw new ORPCError('FORBIDDEN');
  return next();
});
