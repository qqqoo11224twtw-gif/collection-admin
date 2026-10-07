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
  `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('${DEMO_AGENT_ID}', 'Demo Agent', 'agent@example.test', 0, 'user', 1790841600000, 1790841600000) ON CONFLICT DO NOTHING;`,
  ...DEMO_CASES.map(
    (record) =>
      `INSERT INTO cases (id, case_no, code, customer_name, address, amount_due, status, revisit_status, revisit_reason, source, assigned_agent_id, created_at, updated_at) VALUES (${Object.values(record).map(literal).join(',')}) ON CONFLICT DO NOTHING;`,
  ),
  ...DEMO_MEDIA.map(
    ({ fixture: _fixture, ...record }) =>
      `INSERT INTO case_media (id, case_id, storage_key, original_filename, media_type, sort_order, sha256, created_at) VALUES (${Object.values(record).map(literal).join(',')}) ON CONFLICT DO NOTHING;`,
  ),
];
const directory = new URL('../apps/server/.wrangler/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('demo-cases.sql', directory), statements.join('\n'));
console.log(
  'Prepared 18 synthetic cases and 12 private demo images for local D1 only.',
);
