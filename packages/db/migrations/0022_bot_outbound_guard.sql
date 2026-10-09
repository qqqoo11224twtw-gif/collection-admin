CREATE TRIGGER telegram_active_bot_outbound_guard BEFORE INSERT ON telegram_outbound_jobs
WHEN EXISTS (SELECT 1 FROM telegram_routes r LEFT JOIN telegram_bots b ON b.id=r.bot_id WHERE r.id=NEW.route_id AND r.bot_id IS NOT NULL AND (b.id IS NULL OR b.is_active=0))
BEGIN SELECT RAISE(ABORT, 'BOT_DISABLED'); END;
