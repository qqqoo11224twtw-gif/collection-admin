#!/usr/bin/env node
// Run an ad-hoc SQL query against the project's Cloudflare D1 database.
// SQL is read from stdin; rows are written to stdout as JSON (or table).
// Used by Claude (see docs/db-query.md) so we don't write one-off
// inspection scripts every time someone asks a DB question.
//
// Usage:
//   node --env-file .alchemy.env scripts/db-query.ts [opts] <<'SQL'
//   SELECT id, name FROM users LIMIT 5
//   SQL
//
//   opts:
//     --stage <name>    dev (default) | prod | pr-<N>
//     --db <name>       override DB name (default: starter-server-db-<stage>)
//     --format json|table   default json
//     --write           allow non-read-only SQL (DML/DDL). Off by default.
//
// Requires Node 23.6+ for unflagged TypeScript stripping and --env-file.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AccountId, createCloudflareApi } from 'alchemy/cloudflare';

// Single source of truth for the product name: the root package.json
// `saasflare.projectName` field. Rename a fork THERE, once — every
// Worker/DB/KV resource name follows. A dedicated field (not `name`)
// because npm package names allow characters that Cloudflare Worker
// names don't. Read at runtime (not imported) so it works identically
// under node, alchemy, and CI.
const PROJECT_NAME = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).saasflare?.projectName as string | undefined;
if (!PROJECT_NAME || !/^[a-z][a-z0-9-]*$/.test(PROJECT_NAME)) {
  throw new Error(
    `root package.json needs "saasflare": { "projectName": "<lowercase-dashes>" } (got ${JSON.stringify(PROJECT_NAME)})`,
  );
}

const { values } = parseArgs({
  // Strip the standalone `--` that pnpm forwards when invoked as
  // `pnpm db:query -- --foo`; otherwise parseArgs treats it as the
  // option terminator and everything after becomes positional.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    stage: { type: 'string', default: 'dev' },
    db: { type: 'string' },
    format: { type: 'string', default: 'json' },
    write: { type: 'boolean', default: false },
    confirm: { type: 'string' },
  },
  strict: true,
});

const stage = values.stage as string;
const format = values.format as string;
const allowWrite = values.write as boolean;
const confirm = values.confirm as string | undefined;
const dbName =
  (values.db as string | undefined) ?? `${PROJECT_NAME}-server-db-${stage}`;

const sql = readFileSync(0, 'utf-8').trim();
if (!sql) {
  console.error('No SQL provided on stdin.');
  process.exit(1);
}

// Refuse multi-statement SQL (the D1 /query endpoint will accept it and
// our first-keyword check could be bypassed by `SELECT 1; DELETE ...`).
// A single trailing `;` is fine.
const normalizedSql = sql.replace(/;\s*$/, '').trim();
if (normalizedSql.includes(';')) {
  console.error(
    'Refusing multi-statement SQL. Submit one statement per invocation.',
  );
  process.exit(1);
}

// Read-only guard. Strip comments + string/identifier literals so e.g.
// `SELECT 'I want to DELETE this' AS msg` is not flagged, then scan the
// remainder for any write keyword. Catches `WITH x AS (...) DELETE ...`
// style payloads that the previous first-keyword-only check would let
// through.
const sqlForKeywordScan = normalizedSql
  .replace(/--[^\n]*/g, '') // -- line comments
  .replace(/\/\*[\s\S]*?\*\//g, '') // /* block comments */
  .replace(/'(?:[^']|'')*'/g, "''") // '...' string literals (SQL doubles '' to escape)
  .replace(/"(?:[^"]|"")*"/g, '""'); // "..." quoted identifiers
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|REINDEX|VACUUM)\b/i;
const writeMatch = sqlForKeywordScan.match(WRITE_KEYWORDS);
if (writeMatch && !allowWrite) {
  console.error(
    `Refusing SQL that contains a write keyword (${writeMatch[1].toUpperCase()}). Pass --write to override.`,
  );
  process.exit(1);
}

// Extra guard: --write against prod requires a typed confirmation
// (mirrors the `deploy prod` literal-string pattern in docs/deploy.md A8).
if (allowWrite && stage === 'prod' && confirm !== 'write prod') {
  console.error(
    'Refusing --write --stage prod without --confirm "write prod". ' +
      'This is a destructive operation against production — confirm by passing --confirm "write prod".',
  );
  process.exit(1);
}

if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error(
    'CLOUDFLARE_API_TOKEN not set. Run via `node --env-file .alchemy.env ...`.',
  );
  process.exit(1);
}

const api = await createCloudflareApi();
const accountId = await AccountId();

// Resolve D1 database UUID from its name.
const listResp = await api.get(
  `/accounts/${accountId}/d1/database?name=${encodeURIComponent(dbName)}`,
);
if (!listResp.ok) {
  console.error(
    `Failed to list D1 databases: ${listResp.status} ${listResp.statusText}`,
  );
  process.exit(1);
}
const listBody = (await listResp.json()) as {
  result?: Array<{ uuid: string; name: string }>;
};
const db = listBody.result?.find((d) => d.name === dbName);
if (!db) {
  console.error(`D1 database "${dbName}" not found on this account.`);
  process.exit(1);
}

// Run the query.
const queryResp = await api.post(
  `/accounts/${accountId}/d1/database/${db.uuid}/query`,
  { sql, params: [] },
);
const queryBody = (await queryResp.json()) as {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: Array<{
    success: boolean;
    results: Array<Record<string, unknown>>;
    meta?: { duration?: number; rows_read?: number; rows_written?: number };
  }>;
};
if (!queryResp.ok || !queryBody.success) {
  const msg = queryBody.errors
    ?.map((e) => `[${e.code}] ${e.message}`)
    .join('; ');
  console.error(
    `Query failed: ${queryResp.status} ${queryResp.statusText}${msg ? ` — ${msg}` : ''}`,
  );
  process.exit(1);
}

const rows = queryBody.result?.[0]?.results ?? [];
const meta = queryBody.result?.[0]?.meta;

if (format === 'table') {
  console.table(rows);
} else {
  console.log(JSON.stringify(rows, null, 2));
}

console.error(
  `(${rows.length} row${rows.length === 1 ? '' : 's'}${meta?.duration != null ? `, ${meta.duration.toFixed(1)}ms` : ''}, db=${dbName})`,
);
