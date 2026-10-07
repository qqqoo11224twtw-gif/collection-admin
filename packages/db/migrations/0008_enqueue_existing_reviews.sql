INSERT INTO review_items (id,review_type,entity_type,entity_id,case_id,status,priority,source,proposed_data,reason,created_by_user_id,created_at,dedupe_key)
SELECT 'legacy-review-'||id,'report_classification','report',id,case_id,'pending','normal',CASE WHEN source='telegram' THEN 'telegram' ELSE 'manual' END,
json_object('type','report_classification','reportId',id,'reportVersion',version,'originalContent',content,'classification',json_object('status',status,'revisit_status',revisit_status,'revisit_reason',revisit_reason,'payment_detected',json(CASE WHEN payment_detected=1 THEN 'true' ELSE 'false' END),'payment_amount',payment_amount,'confidence',1)),
'Existing report requires manual classification before further case synchronization.',created_by_user_id,updated_at,'report_classification:'||id||':'||version FROM reports WHERE status='needs_review';
--> statement-breakpoint
INSERT INTO audit_logs (id,user_id,action,entity_type,entity_id,metadata,created_at)
SELECT 'legacy-review-created-'||id,created_by_user_id,'review.created','case',case_id,json_object('reviewId',id,'entityId',entity_id),created_at FROM review_items WHERE id LIKE 'legacy-review-%';
