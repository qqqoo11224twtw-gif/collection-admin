import { ORPCError } from '@orpc/server';
import type { telegramRoutes } from '@saasflare-dev/db';
import type { Context } from './context';
import type { TelegramUpdate } from './telegram-contract';
import { telegramPrincipal } from './telegram-principal';
export async function reportRoutePrincipal(
  base: Context,
  route: typeof telegramRoutes.$inferSelect,
  update: TelegramUpdate,
) {
  const m = update.message ?? update.callback_query?.message;
  if (
    !m ||
    route.routeType !== 'collector_report' ||
    !route.isActive ||
    !route.collectorId ||
    route.chatId !== String(m.chat.id) ||
    route.topicId !== (m.message_thread_id ?? null)
  )
    throw new ORPCError('FORBIDDEN');
  const valid = await base.env.DB.prepare(
    "SELECT c.id,c.user_id,r.managed_by_user_id FROM telegram_routes r JOIN collectors c ON c.id=r.collector_id WHERE r.id=? AND r.route_type='collector_report' AND r.is_active=1 AND c.is_active=1 AND (SELECT count(*) FROM telegram_routes WHERE chat_id=r.chat_id AND coalesce(topic_id,0)=coalesce(r.topic_id,0) AND is_active=1)=1",
  )
    .bind(route.id)
    .first<{
      id: string;
      user_id: string | null;
      managed_by_user_id: string;
    }>();
  if (!valid) throw new ORPCError('FORBIDDEN');
  const context = await telegramPrincipal(
    base,
    valid.user_id ?? valid.managed_by_user_id,
    true,
  );
  return { ...context, telegramCollectorId: valid.id };
}
