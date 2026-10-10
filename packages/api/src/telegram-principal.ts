import { ORPCError } from '@orpc/server';
import { user } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
import type { Context } from './context';
import { permissionPolicy } from './permissions';
export async function telegramPrincipal(
  base: Context,
  userId: string,
  collectorScope = false,
): Promise<Context> {
  const [record] =
    base.telegramPrincipalRecord?.id === userId
      ? [base.telegramPrincipalRecord]
      : await base.DB.select().from(user).where(eq(user.id, userId)).limit(1);
  if (
    !record ||
    !record.active ||
    (record.banned &&
      (!record.banExpires || record.banExpires.getTime() > Date.now()))
  )
    throw new ORPCError('FORBIDDEN');
  const now = new Date();
  const context: Context = {
    ...base,
    telegramPrincipalRecord: record,
    user: {
      ...record,
      role: collectorScope ? 'user' : (record.role ?? 'user'),
      permissionAllow: record.permissionAllow,
      permissionDeny: record.permissionDeny,
    },
    session: {
      id: 'telegram-service',
      token: '',
      expiresAt: new Date(now.getTime() + 60000),
    },
    isAdmin: !collectorScope && record.role === 'admin',
  };
  if (
    !collectorScope &&
    !permissionPolicy(context).permissions.includes('telegram_route.manage')
  )
    throw new ORPCError('FORBIDDEN');
  return context;
}
