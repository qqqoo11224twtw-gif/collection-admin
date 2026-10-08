import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ─── better-auth tables (passwordless email-OTP + admin plugin) ───
// Hand-written (not CLI-generated). text id + timestamp_ms, matching the
// proven `tasks`/`affiliate` setup. The `admin` plugin adds role/banned/
// banReason/banExpires to `user` and impersonatedBy to `session`.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .default(false)
    .notNull(),
  image: text('image'),
  // admin plugin
  role: text('role'),
  banned: integer('banned', { mode: 'boolean' }),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  // admin plugin
  impersonatedBy: text('impersonated_by'),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', {
    mode: 'timestamp_ms',
  }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', {
    mode: 'timestamp_ms',
  }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// api-key plugin (@better-auth/api-key). Field list mirrors the plugin's
// schema for better-auth 1.6 — note the owner column is `referenceId`
// (renamed from userId in 1.6). `key` stores the HASH, never the plaintext.
export const apikey = sqliteTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: integer('last_refill_at', { mode: 'timestamp_ms' }),
    enabled: integer('enabled', { mode: 'boolean' }).default(true),
    rateLimitEnabled: integer('rate_limit_enabled', { mode: 'boolean' }),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: integer('last_request', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [
    index('apikey_key_idx').on(t.key),
    index('apikey_reference_idx').on(t.referenceId),
  ],
);

// better-auth built-in rate limiting with storage: 'database' — protects the
// OTP send endpoint from abuse in `open` mode (packages/api/src/auth.ts).
// JS property names (key/count/lastRequest) must match the plugin's model
// fields; lastRequest is a millisecond epoch stored as a plain integer.
export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
});

// ─── Demo data (playground) ───
// Todos are per-user private data: the API layer (protectedProcedure) scopes
// every query to the session user. This is the template's demo of the
// sign-up → sign-in → own-data story.
export const todos = sqliteTable(
  'todos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    completed: integer('completed', { mode: 'boolean' })
      .default(false)
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('todos_user_idx').on(t.userId)],
);

export const CASE_STATUSES = [
  'pending',
  'assigned',
  'follow_up',
  'installment',
  'settled',
  'unresolved',
] as const;
export const CASE_SOURCES = [
  'manual',
  'poster_builder',
  'telegram_ai',
  'historical_import',
] as const;
export const REVISIT_STATUSES = [
  'pending',
  'recommended',
  'not_required',
  'observe',
  'not_recommended',
  'not_needed',
] as const;

export const cases = sqliteTable(
  'cases',
  {
    id: text('id').primaryKey(),
    caseNo: text('case_no').notNull(),
    code: text('code').notNull(),
    customerName: text('customer_name').notNull(),
    address: text('address').notNull(),
    // Phase one stores whole TWD dollars, never floating-point money.
    amountDue: integer('amount_due').notNull(),
    status: text('status', { enum: CASE_STATUSES })
      .notNull()
      .default('pending'),
    revisitStatus: text('revisit_status', { enum: REVISIT_STATUSES })
      .notNull()
      .default('pending'),
    revisitReason: text('revisit_reason').notNull().default(''),
    source: text('source', { enum: CASE_SOURCES }).notNull().default('manual'),
    assignedAgentId: text('assigned_agent_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    version: integer('version').notNull().default(0),
    writeToken: text('write_token').notNull().default(''),
  },
  (t) => [
    uniqueIndex('cases_case_no_idx').on(sql`${t.caseNo} COLLATE NOCASE`),
    index('cases_code_idx').on(sql`${t.code} COLLATE NOCASE`),
    index('cases_customer_name_idx').on(sql`${t.customerName} COLLATE NOCASE`),
    index('cases_updated_idx').on(t.updatedAt, t.id),
    index('cases_agent_updated_idx').on(t.assignedAgentId, t.updatedAt, t.id),
    check(
      'cases_amount_check',
      sql`${t.amountDue} >= 0 AND ${t.amountDue} <= 1000000000000`,
    ),
    check(
      'cases_status_check',
      sql`${t.status} IN ('pending', 'assigned', 'follow_up', 'installment', 'settled', 'unresolved')`,
    ),
    check(
      'cases_source_check',
      sql`${t.source} IN ('manual', 'poster_builder', 'telegram_ai', 'historical_import')`,
    ),
    check(
      'cases_revisit_check',
      sql`${t.revisitStatus} IN ('pending', 'recommended', 'not_required', 'observe', 'not_recommended', 'not_needed')`,
    ),
    check(
      'cases_required_check',
      sql`length(trim(${t.caseNo})) > 0 AND length(trim(${t.code})) > 0 AND length(trim(${t.customerName})) > 0 AND length(trim(${t.address})) > 0`,
    ),
    check('cases_dates_check', sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);

export const caseMedia = sqliteTable(
  'case_media',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    mediaType: text('media_type', {
      enum: ['image/png', 'image/jpeg', 'image/webp'],
    }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    sha256: text('sha256').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('case_media_storage_idx').on(t.storageKey),
    index('case_media_case_sort_idx').on(t.caseId, t.sortOrder, t.id),
    index('case_media_sha256_idx').on(t.sha256),
    check('case_media_sort_check', sql`${t.sortOrder} >= 0`),
    check(
      'case_media_type_check',
      sql`${t.mediaType} IN ('image/png', 'image/jpeg', 'image/webp')`,
    ),
    check(
      'case_media_sha_check',
      sql`length(${t.sha256}) = 64 AND ${t.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
);

export const collectors = sqliteTable(
  'collectors',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    code: text('code').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    // Optional login identity. No Telegram identifiers in this phase.
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    version: integer('version').notNull().default(0),
    writeToken: text('write_token').notNull().default(''),
  },
  (t) => [
    uniqueIndex('collectors_code_idx').on(sql`${t.code} COLLATE NOCASE`),
    uniqueIndex('collectors_user_idx').on(t.userId),
    index('collectors_active_idx').on(t.isActive, t.displayName),
    check(
      'collectors_name_check',
      sql`length(trim(${t.displayName})) > 0 AND length(trim(${t.code})) > 0`,
    ),
    check('collectors_active_check', sql`${t.isActive} IN (0, 1)`),
  ],
);

export const assignments = sqliteTable(
  'assignments',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'restrict' }),
    collectorId: text('collector_id')
      .notNull()
      .references(() => collectors.id, { onDelete: 'restrict' }),
    assignedByUserId: text('assigned_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    assignedAt: integer('assigned_at', { mode: 'timestamp_ms' }).notNull(),
    unassignedAt: integer('unassigned_at', { mode: 'timestamp_ms' }),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('assignments_current_case_idx')
      .on(t.caseId)
      .where(sql`${t.unassignedAt} IS NULL`),
    index('assignments_case_time_idx').on(t.caseId, t.assignedAt),
    index('assignments_collector_idx').on(t.collectorId, t.unassignedAt),
    check(
      'assignments_dates_check',
      sql`${t.unassignedAt} IS NULL OR ${t.unassignedAt} >= ${t.assignedAt}`,
    ),
  ],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type', {
      enum: ['case', 'collector', 'review', 'intake'],
    }).notNull(),
    entityId: text('entity_id').notNull(),
    metadata: text('metadata').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('audit_logs_entity_time_idx').on(
      t.entityType,
      t.entityId,
      t.createdAt,
      t.id,
    ),
    index('audit_logs_user_time_idx').on(t.userId, t.createdAt),
    check('audit_logs_json_check', sql`json_valid(${t.metadata})`),
  ],
);

export const REPORT_STATUSES = [
  'cannot_find',
  'follow_up',
  'installment',
  'settled',
  'unresolved',
  'needs_review',
] as const;
export const REPORT_REVISIT_STATUSES = [
  'recommended',
  'observe',
  'not_recommended',
  'not_needed',
] as const;
export const REPORT_SOURCES = [
  'admin',
  'collector_portal',
  'telegram',
  'api',
] as const;
export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'restrict' }),
    assignmentId: text('assignment_id').references(() => assignments.id, {
      onDelete: 'restrict',
    }),
    collectorId: text('collector_id').references(() => collectors.id, {
      onDelete: 'restrict',
    }),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    content: text('content').notNull(),
    status: text('status', { enum: REPORT_STATUSES }).notNull(),
    revisitStatus: text('revisit_status', { enum: REPORT_REVISIT_STATUSES }),
    revisitReason: text('revisit_reason'),
    paymentDetected: integer('payment_detected', { mode: 'boolean' })
      .notNull()
      .default(false),
    paymentAmount: integer('payment_amount'),
    source: text('source', { enum: REPORT_SOURCES }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    index('reports_case_time_idx').on(t.caseId, t.createdAt, t.id),
    index('reports_assignment_idx').on(t.assignmentId),
    index('reports_collector_idx').on(t.collectorId),
    check(
      'reports_content_check',
      sql`length(trim(${t.content})) BETWEEN 1 AND 10000`,
    ),
    check(
      'reports_status_check',
      sql`${t.status} IN ('cannot_find','follow_up','installment','settled','unresolved','needs_review')`,
    ),
    check(
      'reports_revisit_check',
      sql`${t.revisitStatus} IS NULL OR ${t.revisitStatus} IN ('recommended','observe','not_recommended','not_needed')`,
    ),
    check(
      'reports_source_check',
      sql`${t.source} IN ('admin','collector_portal','telegram','api')`,
    ),
    check(
      'reports_payment_check',
      sql`${t.paymentDetected} IN (0,1) AND (${t.paymentAmount} IS NULL OR (${t.paymentDetected}=1 AND ${t.paymentAmount} BETWEEN 0 AND 1000000000000))`,
    ),
    check('reports_dates_check', sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);

export const REVIEW_TYPES = [
  'report_classification',
  'case_match',
  'image_extraction',
  'payment_detection',
] as const;
export const REVIEW_STATUSES = [
  'pending',
  'approved',
  'corrected',
  'rejected',
] as const;
export const REVIEW_SOURCES = [
  'manual',
  'ai',
  'telegram',
  'historical_import',
] as const;
export const reviewItems = sqliteTable(
  'review_items',
  {
    id: text('id').primaryKey(),
    reviewType: text('review_type', { enum: REVIEW_TYPES }).notNull(),
    entityType: text('entity_type', {
      enum: ['report', 'case', 'intake'],
    }).notNull(),
    entityId: text('entity_id'),
    caseId: text('case_id').references(() => cases.id, {
      onDelete: 'restrict',
    }),
    status: text('status', { enum: REVIEW_STATUSES })
      .notNull()
      .default('pending'),
    priority: text('priority', { enum: ['low', 'normal', 'high'] })
      .notNull()
      .default('normal'),
    source: text('source', { enum: REVIEW_SOURCES }).notNull(),
    proposedData: text('proposed_data').notNull(),
    confirmedData: text('confirmed_data'),
    reason: text('reason').notNull(),
    confidence: real('confidence'),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'restrict',
    }),
    resolvedByUserId: text('resolved_by_user_id').references(() => user.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    dedupeKey: text('dedupe_key').notNull(),
    version: integer('version').notNull().default(0),
    writeToken: text('write_token').notNull().default(''),
  },
  (t) => [
    uniqueIndex('review_items_dedupe_idx').on(t.dedupeKey),
    index('review_items_status_type_time_idx').on(
      t.status,
      t.reviewType,
      t.createdAt,
      t.id,
    ),
    index('review_items_case_time_idx').on(t.caseId, t.createdAt),
    index('review_items_entity_idx').on(t.entityType, t.entityId, t.status),
    check(
      'review_items_type_check',
      sql`${t.reviewType} IN ('report_classification','case_match','image_extraction','payment_detection')`,
    ),
    check(
      'review_items_entity_check',
      sql`${t.entityType} IN ('report','case','intake')`,
    ),
    check(
      'review_items_status_check',
      sql`${t.status} IN ('pending','approved','corrected','rejected')`,
    ),
    check(
      'review_items_priority_check',
      sql`${t.priority} IN ('low','normal','high')`,
    ),
    check(
      'review_items_source_check',
      sql`${t.source} IN ('manual','ai','telegram','historical_import')`,
    ),
    check(
      'review_items_json_check',
      sql`json_valid(${t.proposedData}) AND (${t.confirmedData} IS NULL OR json_valid(${t.confirmedData}))`,
    ),
    check(
      'review_items_confidence_check',
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
    check(
      'review_items_resolution_check',
      sql`(${t.status}='pending' AND ${t.resolvedAt} IS NULL AND ${t.resolvedByUserId} IS NULL AND ${t.confirmedData} IS NULL) OR (${t.status}<>'pending' AND ${t.resolvedAt} IS NOT NULL AND ${t.resolvedByUserId} IS NOT NULL)`,
    ),
  ],
);

export const INTAKE_SOURCES = [
  'manual',
  'telegram',
  'line',
  'poster_builder',
  'historical_import',
  'api',
] as const;
export const INTAKE_STATUSES = [
  'received',
  'processing',
  'needs_review',
  'matched',
  'created',
  'rejected',
  'failed',
] as const;
export const intakeItems = sqliteTable(
  'intake_items',
  {
    id: text('id').primaryKey(),
    source: text('source', { enum: INTAKE_SOURCES }).notNull(),
    externalId: text('external_id'),
    dedupeKey: text('dedupe_key'),
    status: text('status', { enum: INTAKE_STATUSES })
      .notNull()
      .default('received'),
    proposedData: text('proposed_data').notNull(),
    confirmedData: text('confirmed_data'),
    matchedCaseId: text('matched_case_id').references(() => cases.id, {
      onDelete: 'restrict',
    }),
    reviewItemId: text('review_item_id').references(() => reviewItems.id, {
      onDelete: 'restrict',
    }),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
    version: integer('version').notNull().default(0),
    writeToken: text('write_token').notNull().default(''),
    caseNoHint: text('case_no_hint'),
    confidence: real('confidence'),
  },
  (t) => [
    uniqueIndex('intake_source_external_idx').on(t.source, t.externalId),
    uniqueIndex('intake_source_dedupe_idx').on(t.source, t.dedupeKey),
    uniqueIndex('intake_review_idx').on(t.reviewItemId),
    index('intake_status_source_time_idx').on(
      t.status,
      t.source,
      t.createdAt,
      t.id,
    ),
    index('intake_creator_idx').on(t.createdByUserId, t.createdAt),
    check(
      'intake_source_check',
      sql`${t.source} IN ('manual','telegram','line','poster_builder','historical_import','api')`,
    ),
    check(
      'intake_status_check',
      sql`${t.status} IN ('received','processing','needs_review','matched','created','rejected','failed')`,
    ),
    check(
      'intake_json_check',
      sql`json_valid(${t.proposedData}) AND (${t.confirmedData} IS NULL OR json_valid(${t.confirmedData}))`,
    ),
    check(
      'intake_confidence_check',
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
    check(
      'intake_terminal_check',
      sql`${t.status} NOT IN ('matched','created') OR (${t.matchedCaseId} IS NOT NULL AND ${t.confirmedData} IS NOT NULL AND ${t.processedAt} IS NOT NULL)`,
    ),
    check('intake_dates_check', sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);
export const intakeMedia = sqliteTable(
  'intake_media',
  {
    id: text('id').primaryKey(),
    intakeId: text('intake_id')
      .notNull()
      .references(() => intakeItems.id, { onDelete: 'restrict' }),
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    mediaType: text('media_type', {
      enum: ['image/png', 'image/jpeg', 'image/webp'],
    }).notNull(),
    sha256: text('sha256').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    isDuplicate: integer('is_duplicate', { mode: 'boolean' })
      .notNull()
      .default(false),
    promotedCaseMediaId: text('promoted_case_media_id').references(
      () => caseMedia.id,
      { onDelete: 'set null' },
    ),
    promotedAt: integer('promoted_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('intake_media_storage_idx').on(t.storageKey),
    uniqueIndex('intake_media_promotion_idx').on(t.promotedCaseMediaId),
    index('intake_media_sort_idx').on(t.intakeId, t.sortOrder, t.id),
    index('intake_media_sha_idx').on(t.sha256),
    check(
      'intake_media_sha_check',
      sql`length(${t.sha256})=64 AND ${t.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check('intake_media_sort_check', sql`${t.sortOrder} >= 0`),
    check(
      'intake_media_type_check',
      sql`${t.mediaType} IN ('image/png','image/jpeg','image/webp')`,
    ),
  ],
);
