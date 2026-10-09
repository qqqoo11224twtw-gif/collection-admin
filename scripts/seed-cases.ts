import { mkdirSync, writeFileSync } from 'node:fs';
import {
  DEMO_AGENT_ID,
  DEMO_CASES,
  DEMO_MEDIA,
} from '../packages/db/src/demo-cases.ts';

function literal(value: string | number | null) {
  return value === null
    ? 'NULL'
    : typeof value === 'number'
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;
}
const statements = [
  ...[
    'admin@example.test',
    'phase2-admin@example.test',
    'phase3-admin@example.test',
    'phase4-admin@example.test',
    'phase5-admin@example.test',
    'phase6-admin@example.test',
    'phase7-admin@example.test',
    'phase8-admin@example.test',
  ].map(
    (email) =>
      `INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES (${literal(`local-${email}`)},'虛構測試管理員',${literal(email)},0,'admin',1790841600000,1790841600000) ON CONFLICT(email) DO NOTHING;`,
  ),
  `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('${DEMO_AGENT_ID}', 'Demo Agent', 'agent@example.test', 0, 'user', 1790841600000, 1790841600000) ON CONFLICT DO NOTHING;`,
  ...DEMO_CASES.map(
    (record) =>
      `INSERT INTO cases (id, case_no, code, customer_name, address, amount_due, status, revisit_status, revisit_reason, source, assigned_agent_id, created_at, updated_at) VALUES (${Object.values(record).map(literal).join(',')}) ON CONFLICT DO NOTHING;`,
  ),
  ...DEMO_MEDIA.map(
    ({ fixture: _fixture, ...record }) =>
      `INSERT INTO case_media (id, case_id, storage_key, original_filename, media_type, sort_order, sha256, created_at) VALUES (${Object.values(record).map(literal).join(',')}) ON CONFLICT DO NOTHING;`,
  ),
  `INSERT INTO collectors (id,display_name,code,is_active,user_id,created_at,updated_at) VALUES ('demo-collector','Demo Agent','DEMO-AGENT',1,'${DEMO_AGENT_ID}',1790841600000,1790841600000) ON CONFLICT DO NOTHING;`,
  ...DEMO_CASES.filter((record) => record.assignedAgentId).map(
    (record) =>
      `INSERT INTO assignments (id,case_id,collector_id,assigned_by_user_id,assigned_at,note) SELECT ${literal(`demo-assignment-${record.id}`)},${literal(record.id)},id,'${DEMO_AGENT_ID}',${record.updatedAt},'Fictional demo assignment' FROM collectors WHERE user_id='${DEMO_AGENT_ID}' AND NOT EXISTS (SELECT 1 FROM assignments WHERE case_id=${literal(record.id)}) ON CONFLICT DO NOTHING;`,
  ),
];
const directory = new URL('../apps/server/.wrangler/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('demo-cases.sql', directory), statements.join('\n'));
console.log(
  'Prepared 18 synthetic cases and 12 private demo images for local D1 only.',
);
