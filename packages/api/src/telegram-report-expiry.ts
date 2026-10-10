/** Fixed conversation deadlines, with one safe audit event per expired draft. */
export async function expireReportConversations(
  db: D1Database,
  now = Date.now(),
) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT lower(hex(randomblob(16))),NULL,'TELEGRAM_REPORT_EXPIRED','telegram',id,json_object('conversation_id',id,'route_id',route_id,'collector_id',collector_id,'case_id',case_id,'created_at',created_at,'expired_at',expires_at),? FROM telegram_report_conversations WHERE kind='report' AND stage IN ('selecting','content','submitting','status') AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM audit_logs a WHERE a.entity_id=telegram_report_conversations.id AND a.action='TELEGRAM_REPORT_EXPIRED')",
      )
      .bind(now, now),
    db
      .prepare(
        "UPDATE telegram_report_conversations SET stage='expired',updated_at=? WHERE kind='report' AND stage IN ('selecting','content','submitting','status') AND expires_at<=?",
      )
      .bind(now, now),
  ]);
}
