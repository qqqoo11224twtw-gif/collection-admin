INSERT INTO finance_settings(id,admin_commission_rate,version,write_token,updated_at)
VALUES('global',0,0,'',0) ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
INSERT INTO payment_allocations(id,payment_id,schedule_id,amount,created_at)
SELECT 'legacy-'||id,id,installment_schedule_id,received_amount,created_at
FROM payments WHERE installment_schedule_id IS NOT NULL
ON CONFLICT(payment_id,schedule_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO remittances(id,idempotency_key,collector_id,amount,received_date,note,created_by_user_id,created_at)
SELECT 'legacy-'||s.id,'legacy-'||s.id,s.collector_id,s.return_amount,
substr(datetime(s.returned_at/1000,'unixepoch','+8 hours'),1,10),'既有已回款紀錄',s.returned_by_user_id,s.returned_at
FROM settlements s JOIN payments p ON p.id=s.payment_id
WHERE s.return_status='returned' AND s.collector_id IS NOT NULL AND s.return_amount>0 AND p.status='received'
ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
INSERT INTO remittance_allocations(id,remittance_id,settlement_id,component,amount)
SELECT 'legacy-'||s.id,'legacy-'||s.id,s.id,'principal',s.return_amount
FROM settlements s WHERE EXISTS(SELECT 1 FROM remittances r WHERE r.id='legacy-'||s.id)
ON CONFLICT(remittance_id,settlement_id,component) DO NOTHING;
