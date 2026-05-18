# db-query

Ad-hoc read-only SQL against the project's Cloudflare D1 database. Use
this instead of writing a one-off `scripts/inspect-*.ts` every time you
want to look at a row or count records.

## When to use

Anything that's "show me what's actually in the DB right now":

- *"How many todos are in dev?"*
- *"List the last 5 users that signed up on prod."*
- *"What tables exist?"*
- *"Show the schema for `posts`."*
- *"Is row 42 marked completed?"*

## When NOT to use

- The answer is in code/docs/migrations — use Read/Grep.
- You're applying a schema change — write a proper Drizzle migration
  under `packages/db/migrations/` and run `pnpm db:generate` /
  `deploy:*` (alchemy applies migrations on deploy).
- You're seeding/repairing data — write a reviewable script in
  `packages/db/scripts/` (we don't have one yet; create it when needed)
  or use the server's API.

## How to invoke

```bash
pnpm db:query <<'SQL'
SELECT id, name, email FROM users LIMIT 5
SQL
```

Rows go to stdout as JSON. Row count + duration go to stderr.

### Common flags

`pnpm` forwards args after `--` to the script:

```bash
# Wide result → console.table grid (easier to read for >3 columns)
pnpm db:query -- --format=table <<'SQL'
SELECT id, text, completed, created_at FROM todos ORDER BY id DESC LIMIT 10
SQL

# Hit prod instead of dev
pnpm db:query -- --stage prod <<'SQL'
SELECT COUNT(*) AS n FROM users
SQL

# Specific PR preview stage
pnpm db:query -- --stage pr-42 <<'SQL'
SELECT * FROM posts
SQL

# Custom DB name (escape hatch — usually --stage is enough)
pnpm db:query -- --db starter-server-db-dev <<'SQL'
SELECT * FROM todos
SQL
```

### Write mode (avoid)

The script refuses any SQL whose first keyword isn't `SELECT`, `WITH`,
`PRAGMA`, or `EXPLAIN`. To override:

```bash
pnpm db:query -- --write <<'SQL'
UPDATE todos SET completed = 1 WHERE id = 7
SQL
```

**Confirm with a human first.** For anything beyond a one-off cleanup,
write a proper script — `--write` exists for emergencies, not workflows.

## Schema

Drizzle schema lives in [`packages/db/src/schema.ts`](../packages/db/src/schema.ts).
Migrations live in `packages/db/migrations/`. Inspect a table's actual
columns at runtime if you suspect drift:

```bash
pnpm db:query -- --format=table <<'SQL'
PRAGMA table_info(users)
SQL
```

List all user tables (skipping CF / Drizzle internals):

```bash
pnpm db:query <<'SQL'
SELECT name FROM sqlite_master
WHERE type = 'table'
  AND name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '_cf_%'
  AND name != 'd1_migrations'
ORDER BY name
SQL
```

## D1 peculiarities

- **It's SQLite.** Use SQLite syntax — no `BOOLEAN` column type
  (integers 0/1), no `TIMESTAMP` (integers, Unix epoch — wrap with
  `datetime(col, 'unixepoch')` to read).
- **`JSON1` is enabled.** `json_extract`, `json_each` work in queries.
- **No subqueries in `LIMIT` clauses.** Use a CTE.
- **Stage isolation is total.** Each stage (`dev`, `prod`, `pr-<N>`) has
  its own D1 DB. Dev data ≠ prod data ≠ PR data.

## How it works

`scripts/db-query.ts`:

1. Reads SQL from stdin
2. Resolves D1 database UUID via the CF API
   (`GET /accounts/{id}/d1/database?name=starter-server-db-<stage>`)
3. Posts the query
   (`POST /accounts/{id}/d1/database/{uuid}/query`)
4. Prints `result[0].results` to stdout

Auth: reads `CLOUDFLARE_API_TOKEN` from `.alchemy.env` (the root pnpm
script invokes `node --env-file=.alchemy.env`). The token's standard
alchemy scopes already include D1 — no extra setup.
