ALTER TABLE `settlements` ADD `collector_received_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `settlements` ADD `principal_return_due_from_collector` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `settlements` ADD `collector_entitlement` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Preserve the original customer amount/split and rate snapshots. These new
-- fields describe collector cash and obligations, not customer receipts.
UPDATE settlements SET
  collector_received_amount=CASE WHEN (SELECT channel FROM payments WHERE id=settlements.payment_id)='collector_received' THEN received_amount ELSE 0 END,
  principal_return_due_from_collector=CASE WHEN (SELECT channel FROM payments WHERE id=settlements.payment_id)='collector_received' THEN return_amount ELSE 0 END,
  collector_entitlement=CASE WHEN (SELECT channel FROM payments WHERE id=settlements.payment_id)='direct_to_principal' THEN commission_amount ELSE 0 END;
--> statement-breakpoint
-- Older callers/fixtures retain the same customer snapshot columns. Normalize
-- their collector projection on insert; never alter payment or rate snapshots.
CREATE TRIGGER settlement_cash_projection_insert AFTER INSERT ON settlements BEGIN UPDATE settlements SET collector_received_amount=0,principal_return_due_from_collector=0,collector_entitlement=0 WHERE id=NEW.id; UPDATE settlements SET collector_received_amount=NEW.received_amount,principal_return_due_from_collector=NEW.return_amount WHERE id=NEW.id AND EXISTS(SELECT 1 FROM payments WHERE id=NEW.payment_id AND channel='collector_received'); UPDATE settlements SET collector_entitlement=NEW.commission_amount WHERE id=NEW.id AND EXISTS(SELECT 1 FROM payments WHERE id=NEW.payment_id AND channel='direct_to_principal'); END;
--> statement-breakpoint
-- Old offset allocation rows remain historical evidence, but no longer reduce
-- unrelated obligations. Source-payment entitlement is settled by its offset.
INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at)
SELECT 'migration-0037:'||s.id,NULL,'DIRECT_PAYMENT_LEDGER_CORRECTED','finance',s.id,
  json_object('payment_id',s.payment_id,'collector_received_amount',0,'principal_return_due_from_collector',0,'collector_entitlement',s.collector_entitlement,'legacy_allocations_preserved',1),
  CAST(strftime('%s','now') AS INTEGER)*1000
FROM settlements s JOIN payments p ON p.id=s.payment_id WHERE p.channel='direct_to_principal';
