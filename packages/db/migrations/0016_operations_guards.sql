CREATE TRIGGER telegram_route_insert_guard BEFORE INSERT ON telegram_routes
WHEN NEW.is_active=1
BEGIN
 SELECT CASE WHEN NEW.route_type IN ('collector_report','collector_dispatch') AND (NEW.collector_id IS NULL OR NOT EXISTS(SELECT 1 FROM collectors WHERE id=NEW.collector_id AND is_active=1)) THEN RAISE(ABORT,'ROUTE_COLLECTOR_INVALID') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM telegram_routes r WHERE r.is_active=1 AND ((r.chat_id=NEW.chat_id AND coalesce(r.topic_id,0)=coalesce(NEW.topic_id,0)) OR (NEW.route_type='collector_report' AND r.route_type='collector_report' AND r.collector_id=NEW.collector_id))) THEN RAISE(ABORT,'ROUTE_CONFLICT') END;
END;
--> statement-breakpoint
CREATE TRIGGER telegram_route_update_guard BEFORE UPDATE ON telegram_routes
WHEN NEW.is_active=1
BEGIN
 SELECT CASE WHEN NEW.route_type IN ('collector_report','collector_dispatch') AND (NEW.collector_id IS NULL OR NOT EXISTS(SELECT 1 FROM collectors WHERE id=NEW.collector_id AND is_active=1)) THEN RAISE(ABORT,'ROUTE_COLLECTOR_INVALID') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM telegram_routes r WHERE r.id<>NEW.id AND r.is_active=1 AND ((r.chat_id=NEW.chat_id AND coalesce(r.topic_id,0)=coalesce(NEW.topic_id,0)) OR (NEW.route_type='collector_report' AND r.route_type='collector_report' AND r.collector_id=NEW.collector_id))) THEN RAISE(ABORT,'ROUTE_CONFLICT') END;
END;
--> statement-breakpoint
CREATE TRIGGER operational_system_events AFTER INSERT ON audit_logs
WHEN NEW.action LIKE 'telegram.%' OR NEW.action LIKE 'assignment.outbound_%' OR NEW.action LIKE 'report.outbound_%' OR NEW.action LIKE 'image_extraction.%' OR NEW.action LIKE 'media.%' OR NEW.action LIKE 'intake.media_%'
BEGIN
 INSERT INTO system_logs(id,timestamp,level,category,event,status,safe_message,related_case_id,related_collector_id,related_job_id,related_route_id,related_user_id,correlation_id,retry_count,error_code)
 VALUES(lower(hex(randomblob(16))),NEW.created_at,
 CASE WHEN NEW.action LIKE '%failed' THEN 'error' WHEN NEW.action LIKE '%retry' OR NEW.action LIKE '%denied' OR NEW.action LIKE '%rejected' THEN 'warning' ELSE 'info' END,
 CASE WHEN NEW.action LIKE 'image_extraction.%' THEN 'openai' WHEN NEW.action LIKE 'media.%' OR NEW.action LIKE 'intake.media_%' THEN 'storage' WHEN NEW.action LIKE '%outbound_%' THEN 'outbound' ELSE 'telegram' END,
 NEW.action,
 CASE WHEN NEW.action LIKE '%failed' THEN 'failed' WHEN NEW.action LIKE '%retry' THEN 'retry' ELSE 'success' END,
 CASE json_extract(NEW.metadata,'$.code') WHEN 'DELIVERY_UNKNOWN' THEN 'Telegram 送達狀態無法確認，請人工檢查群組。' WHEN 'API_403' THEN 'Bot 可能沒有該群組權限。' WHEN 'API_400' THEN 'Telegram API 拒絕，請確認群組與 Topic。' ELSE '系統事件已記錄。' END,
 CASE WHEN NEW.entity_type='case' THEN NEW.entity_id ELSE (SELECT coalesce(a.case_id,r.case_id) FROM telegram_outbound_jobs j LEFT JOIN assignments a ON a.id=j.assignment_id LEFT JOIN reports r ON r.id=j.report_id WHERE j.id=NEW.entity_id) END,
 (SELECT coalesce(a.collector_id,r.collector_id) FROM telegram_outbound_jobs j LEFT JOIN assignments a ON a.id=j.assignment_id LEFT JOIN reports r ON r.id=j.report_id WHERE j.id=NEW.entity_id),
 CASE WHEN NEW.action LIKE '%outbound_%' THEN NEW.entity_id END,
 (SELECT route_id FROM telegram_outbound_jobs WHERE id=NEW.entity_id),NEW.user_id,lower(hex(randomblob(16))),
 CASE WHEN typeof(json_extract(NEW.metadata,'$.attempt'))='integer' THEN json_extract(NEW.metadata,'$.attempt') END,
 CASE WHEN json_extract(NEW.metadata,'$.code') IN ('DELIVERY_UNKNOWN','API_400','API_403','API_429','ROUTE_CHANGED','SOURCE_DENIED','PERMISSION_DENIED','PROCESSING_RETRY','AI_INVALID_OUTPUT','AI_LOW_CONFIDENCE','OPENAI_RATE_LIMIT','OPENAI_UNAVAILABLE') THEN json_extract(NEW.metadata,'$.code') END);
END;
