CREATE TRIGGER assignments_void_case_guard BEFORE INSERT ON assignments WHEN EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND voided_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'CASE_VOIDED'); END;
--> statement-breakpoint
CREATE TRIGGER reports_void_case_guard BEFORE INSERT ON reports WHEN EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND voided_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'CASE_VOIDED'); END;
--> statement-breakpoint
CREATE TRIGGER installment_plans_void_case_guard BEFORE INSERT ON installment_plans WHEN EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND voided_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'CASE_VOIDED'); END;
--> statement-breakpoint
CREATE TRIGGER payments_void_case_guard BEFORE INSERT ON payments WHEN EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND voided_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'CASE_VOIDED'); END;
--> statement-breakpoint
CREATE TRIGGER void_case_update_guard BEFORE UPDATE ON cases WHEN OLD.voided_at IS NOT NULL AND NEW.version<>OLD.version BEGIN SELECT RAISE(ABORT,'CASE_VOIDED'); END;
--> statement-breakpoint
CREATE TRIGGER historical_dispatch_guard BEFORE INSERT ON telegram_outbound_jobs WHEN NEW.message_type='assignment_dispatch' AND NOT EXISTS(SELECT 1 FROM assignments a JOIN cases c ON c.id=a.case_id WHERE a.id=NEW.assignment_id AND a.record_type='assignment' AND c.voided_at IS NULL) BEGIN SELECT RAISE(ABORT,'NOT_FORMAL_ASSIGNMENT'); END;

--> statement-breakpoint
DROP TRIGGER assignment_correction_insert;
--> statement-breakpoint
CREATE TRIGGER assignment_correction_insert BEFORE INSERT ON assignments WHEN NEW.record_type NOT IN ('assignment','correction','historical') OR (NEW.record_type='historical' AND (NEW.corrected_from_id IS NOT NULL OR NEW.correction_reason IS NULL OR length(trim(NEW.correction_reason))=0)) OR (NEW.record_type='correction' AND (NEW.corrected_from_id IS NULL OR NEW.correction_reason IS NULL OR length(trim(NEW.correction_reason))=0 OR NOT EXISTS(SELECT 1 FROM assignments a WHERE a.id=NEW.corrected_from_id AND a.case_id=NEW.case_id))) BEGIN SELECT RAISE(ABORT,'INVALID_CORRECTION'); END;
