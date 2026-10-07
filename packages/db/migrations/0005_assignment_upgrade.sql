INSERT INTO user (id,name,email,email_verified,role,banned,created_at,updated_at)
SELECT 'assignment-migration-system','Legacy assignment import','assignment-import@example.invalid',0,'user',1,unixepoch()*1000,unixepoch()*1000
WHERE EXISTS (SELECT 1 FROM cases WHERE assigned_agent_id IS NOT NULL);
--> statement-breakpoint
INSERT INTO collectors (id,display_name,code,is_active,user_id,created_at,updated_at)
SELECT 'legacy-collector-' || u.id,u.name,'LEGACY-' || u.id,1,u.id,u.created_at,u.updated_at
FROM user u WHERE EXISTS (SELECT 1 FROM cases WHERE assigned_agent_id=u.id);
--> statement-breakpoint
INSERT INTO assignments (id,case_id,collector_id,assigned_by_user_id,assigned_at,note)
SELECT 'legacy-assignment-' || c.id,c.id,'legacy-collector-' || c.assigned_agent_id,'assignment-migration-system',c.updated_at,
'Imported phase-one assignment snapshot. Original actor and assignment time were not recorded.'
FROM cases c WHERE c.assigned_agent_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'Audit logs are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'Audit logs are append-only'); END;
