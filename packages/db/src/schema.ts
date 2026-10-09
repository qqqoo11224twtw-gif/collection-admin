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
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  permissionAllow: text('permission_allow').notNull().default('[]'),
  permissionDeny: text('permission_deny').notNull().default('[]'),
  permissionVersion: integer('permission_version').notNull().default(0),
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

export const systemLogs = sqliteTable(
  'system_logs',
  {
    id: text('id').primaryKey(),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    level: text('level', {
      enum: ['info', 'warning', 'error', 'critical'],
    }).notNull(),
    category: text('category').notNull(),
    event: text('event').notNull(),
    status: text('status').notNull(),
    safeMessage: text('safe_message').notNull(),
    relatedCaseId: text('related_case_id'),
    relatedCollectorId: text('related_collector_id'),
    relatedJobId: text('related_job_id'),
    relatedRouteId: text('related_route_id'),
    relatedUserId: text('related_user_id'),
    correlationId: text('correlation_id').notNull(),
    durationMs: integer('duration_ms'),
    retryCount: integer('retry_count'),
    errorCode: text('error_code'),
    handledStatus: text('handled_status', {
      enum: ['pending', 'acknowledged', 'resolved'],
    })
      .notNull()
      .default('pending'),
    handledBy: text('handled_by').references(() => user.id),
    handledAt: integer('handled_at', { mode: 'timestamp_ms' }),
    note: text('note'),
  },
  (t) => [
    index('system_logs_time_idx').on(t.timestamp),
    index('system_logs_filter_idx').on(t.category, t.level, t.timestamp),
    index('system_logs_case_idx').on(t.relatedCaseId),
  ],
);

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

import { REGIONS } from './regions';

export { REGIONS } from './regions';
export const cases = sqliteTable(
  'cases',
  {
    id: text('id').primaryKey(),
    caseNo: text('case_no').notNull(),
    code: text('code').notNull(),
    region: text('region', { enum: REGIONS }),
    manualEntryKey: text('manual_entry_key').unique(),
    voidedAt: integer('voided_at', { mode: 'timestamp_ms' }),
    voidedBy: text('voided_by').references(() => user.id, {
      onDelete: 'restrict',
    }),
    voidNote: text('void_note'),
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
    index('cases_region_updated_idx').on(t.region, t.updatedAt, t.id),
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
    recordType: text('record_type', {
      enum: ['assignment', 'correction', 'historical'],
    })
      .notNull()
      .default('assignment'),
    correctedFromId: text('corrected_from_id'),
    correctionReason: text('correction_reason'),
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
      enum: [
        'case',
        'collector',
        'review',
        'intake',
        'telegram',
        'bulk_assignment',
      ],
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
    originKey: text('origin_key').unique(),
    workflowStatus: text('workflow_status', {
      enum: ['awaiting_status', 'completed'],
    })
      .notNull()
      .default('completed'),
    selectedStatus: text('selected_status', {
      enum: ['settled', 'installment', 'unresolved', 'follow_up'],
    }),
    completedByUserId: text('completed_by_user_id').references(() => user.id, {
      onDelete: 'restrict',
    }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    callbackToken: text('callback_token').unique(),
    telegramUserId: text('telegram_user_id'),
    callbackRouteId: text('callback_route_id').references(
      () => telegramRoutes.id,
      { onDelete: 'restrict' },
    ),
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
    check(
      'reports_workflow_check',
      sql`${t.workflowStatus} IN ('awaiting_status','completed') AND (${t.workflowStatus}<>'awaiting_status' OR (${t.source}='telegram' AND ${t.callbackToken} IS NOT NULL AND ${t.telegramUserId} IS NOT NULL AND ${t.callbackRouteId} IS NOT NULL AND ${t.assignmentId} IS NOT NULL AND ${t.status}='needs_review' AND ${t.completedAt} IS NULL))`,
    ),
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
    receivedData: text('received_data'),
    extractionKey: text('extraction_key'),
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

export const TELEGRAM_ROUTE_TYPES = [
  'intake',
  'collector_dispatch',
  'collector_report',
  'business_report',
  'collector',
  'report_destination',
  'intake_source',
] as const;
export const telegramRoutes = sqliteTable(
  'telegram_routes',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().default(''),
    collectorId: text('collector_id').references(() => collectors.id, {
      onDelete: 'restrict',
    }),
    chatId: text('chat_id').notNull(),
    topicId: integer('topic_id'),
    routeType: text('route_type', { enum: TELEGRAM_ROUTE_TYPES }).notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    managedByUserId: text('managed_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('telegram_routes_target_idx').on(
      t.chatId,
      sql`coalesce(${t.topicId},0)`,
      t.routeType,
    ),
    check(
      'telegram_route_type_check',
      sql`${t.routeType} IN ('collector','report_destination','intake_source','intake','collector_dispatch','collector_report','business_report')`,
    ),
    check(
      'telegram_route_topic_check',
      sql`${t.topicId} IS NULL OR ${t.topicId}>0`,
    ),
  ],
);

export const telegramIdentities = sqliteTable('telegram_identities', {
  id: text('id').primaryKey(),
  telegramUserId: text('telegram_user_id').notNull().unique(),
  collectorId: text('collector_id').references(() => collectors.id, {
    onDelete: 'restrict',
  }),
  userId: text('user_id').references(() => user.id, { onDelete: 'restrict' }),
  displayName: text('display_name'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const telegramAlbums = sqliteTable(
  'telegram_albums',
  {
    id: text('id').primaryKey(),
    intakeId: text('intake_id').references(() => intakeItems.id, {
      onDelete: 'restrict',
    }),
    routeId: text('route_id')
      .notNull()
      .references(() => telegramRoutes.id, { onDelete: 'restrict' }),
    dueAt: integer('due_at', { mode: 'timestamp_ms' }).notNull(),
    finalizedAt: integer('finalized_at', { mode: 'timestamp_ms' }),
    version: integer('version').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('telegram_album_due_idx').on(t.dueAt, t.finalizedAt)],
);

export const telegramUpdates = sqliteTable(
  'telegram_updates',
  {
    id: text('id').primaryKey(),
    payload: text('payload').notNull(),
    status: text('status', {
      enum: ['pending', 'processing', 'done', 'failed'],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
    leaseToken: text('lease_token'),
    albumId: text('album_id').references(() => telegramAlbums.id, {
      onDelete: 'restrict',
    }),
    intakeId: text('intake_id').references(() => intakeItems.id, {
      onDelete: 'restrict',
    }),
    mediaId: text('media_id').references(() => intakeMedia.id, {
      onDelete: 'restrict',
    }),
    reportId: text('report_id').references(() => reports.id, {
      onDelete: 'restrict',
    }),
    resultCode: text('result_code'),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('telegram_updates_due_idx').on(t.status, t.nextAttemptAt),
    check('telegram_update_json_check', sql`json_valid(${t.payload})`),
    check(
      'telegram_update_status_check',
      sql`${t.status} IN ('pending','processing','done','failed')`,
    ),
  ],
);

export const telegramOutboundJobs = sqliteTable(
  'telegram_outbound_jobs',
  {
    id: text('id').primaryKey(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    messageType: text('message_type', {
      enum: ['report_destination', 'command_reply', 'assignment_dispatch'],
    }).notNull(),
    reportId: text('report_id').references(() => reports.id, {
      onDelete: 'restrict',
    }),
    assignmentId: text('assignment_id')
      .unique()
      .references(() => assignments.id, {
        onDelete: 'restrict',
      }),
    routeId: text('route_id')
      .notNull()
      .references(() => telegramRoutes.id, { onDelete: 'restrict' }),
    payload: text('payload').notNull(),
    status: text('status', { enum: ['pending', 'sending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }),
    leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
    leaseToken: text('lease_token'),
    telegramMessageId: text('telegram_message_id'),
    dispatchState: text('dispatch_state'),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('telegram_outbound_due_idx').on(t.status, t.nextAttemptAt),
    check('telegram_outbound_json_check', sql`json_valid(${t.payload})`),
    check(
      'telegram_outbound_status_check',
      sql`${t.status} IN ('pending','sending','sent','failed')`,
    ),
  ],
);

export const aiImageJobs = sqliteTable(
  'ai_image_jobs',
  {
    id: text('id').primaryKey(),
    intakeId: text('intake_id')
      .notNull()
      .references(() => intakeItems.id, { onDelete: 'restrict' }),
    mediaId: text('media_id')
      .notNull()
      .references(() => intakeMedia.id, { onDelete: 'restrict' }),
    sha256: text('sha256').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    providerVersion: text('provider_version').notNull(),
    status: text('status', {
      enum: ['pending', 'processing', 'succeeded', 'failed'],
    })
      .notNull()
      .default('pending'),
    result: text('result'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
    leaseToken: text('lease_token'),
    errorCode: text('error_code'),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('ai_image_jobs_dedupe_idx').on(
      t.intakeId,
      t.sha256,
      t.provider,
      t.model,
      t.providerVersion,
    ),
    index('ai_image_jobs_due_idx').on(t.status, t.nextAttemptAt),
    check(
      'ai_image_result_json_check',
      sql`${t.result} IS NULL OR json_valid(${t.result})`,
    ),
    check(
      'ai_image_status_check',
      sql`${t.status} IN ('pending','processing','succeeded','failed')`,
    ),
  ],
);
export const aiUsageLogs = sqliteTable(
  'ai_usage_logs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').references(() => aiImageJobs.id, {
      onDelete: 'restrict',
    }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    taskType: text('task_type', { enum: ['image_extraction'] }).notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    errorCode: text('error_code'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('ai_usage_model_time_idx').on(t.provider, t.model, t.createdAt),
    check('ai_usage_task_check', sql`${t.taskType}='image_extraction'`),
    check(
      'ai_usage_count_check',
      sql`(${t.inputTokens} IS NULL OR ${t.inputTokens}>=0) AND (${t.outputTokens} IS NULL OR ${t.outputTokens}>=0) AND ${t.durationMs}>=0`,
    ),
  ],
);

export const installmentPlans = sqliteTable(
  'installment_plans',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'restrict' }),
    reportId: text('report_id').references(() => reports.id, {
      onDelete: 'restrict',
    }),
    collectorId: text('collector_id').references(() => collectors.id, {
      onDelete: 'restrict',
    }),
    planType: text('plan_type', {
      enum: ['deadline', 'weekly', 'monthly'],
    }).notNull(),
    totalAmount: integer('total_amount').notNull(),
    perPaymentAmount: integer('per_payment_amount'),
    weekday: integer('weekday'),
    dayOfMonth: integer('day_of_month'),
    deadlineDate: text('deadline_date'),
    status: text('status', { enum: ['active', 'completed', 'cancelled'] })
      .notNull()
      .default('active'),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    version: integer('version').notNull().default(0),
    writeToken: text('write_token').notNull().default(''),
  },
  (t) => [
    uniqueIndex('installment_report_idx').on(t.reportId),
    uniqueIndex('installment_active_case_idx')
      .on(t.caseId)
      .where(sql`${t.status}='active'`),
    index('installment_case_idx').on(t.caseId, t.createdAt),
    check(
      'installment_amount_check',
      sql`${t.totalAmount}>0 AND ${t.totalAmount}<=1000000000000 AND (${t.perPaymentAmount} IS NULL OR (${t.perPaymentAmount}>0 AND ${t.perPaymentAmount}<=${t.totalAmount}))`,
    ),
    check(
      'installment_type_check',
      sql`(${t.planType}='deadline' AND ${t.deadlineDate} IS NOT NULL AND ${t.perPaymentAmount} IS NULL AND ${t.weekday} IS NULL AND ${t.dayOfMonth} IS NULL) OR (${t.planType}='weekly' AND ${t.weekday} BETWEEN 1 AND 7 AND ${t.perPaymentAmount} IS NOT NULL AND ${t.dayOfMonth} IS NULL AND ${t.deadlineDate} IS NULL) OR (${t.planType}='monthly' AND ${t.dayOfMonth} BETWEEN 1 AND 31 AND ${t.perPaymentAmount} IS NOT NULL AND ${t.weekday} IS NULL AND ${t.deadlineDate} IS NULL)`,
    ),
    check(
      'installment_status_check',
      sql`${t.status} IN ('active','completed','cancelled')`,
    ),
  ],
);

export const installmentSchedules = sqliteTable(
  'installment_schedules',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => installmentPlans.id, { onDelete: 'restrict' }),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    dueDate: text('due_date').notNull(),
    expectedAmount: integer('expected_amount').notNull(),
    paidAmount: integer('paid_amount').notNull().default(0),
    status: text('status', {
      enum: ['pending', 'partial', 'paid', 'overdue', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('schedule_plan_sequence_idx').on(t.planId, t.sequence),
    index('schedule_case_due_idx').on(t.caseId, t.dueDate),
    check(
      'schedule_amount_check',
      sql`${t.expectedAmount}>0 AND ${t.paidAmount}>=0 AND ${t.paidAmount}<=${t.expectedAmount}`,
    ),
    check(
      'schedule_status_check',
      sql`${t.status} IN ('pending','partial','paid','overdue','cancelled')`,
    ),
  ],
);

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'restrict' }),
    installmentPlanId: text('installment_plan_id').references(
      () => installmentPlans.id,
      { onDelete: 'restrict' },
    ),
    installmentScheduleId: text('installment_schedule_id').references(
      () => installmentSchedules.id,
      { onDelete: 'restrict' },
    ),
    collectorId: text('collector_id').references(() => collectors.id, {
      onDelete: 'restrict',
    }),
    receivedDate: text('received_date').notNull(),
    receivedAmount: integer('received_amount').notNull(),
    status: text('status', { enum: ['received', 'voided'] })
      .notNull()
      .default('received'),
    source: text('source', {
      enum: ['telegram', 'admin', 'installment', 'manual'],
    }).notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    version: integer('version').notNull().default(0),
    writeToken: text('write_token').notNull().default(''),
  },
  (t) => [
    index('payments_case_date_idx').on(t.caseId, t.receivedDate),
    index('payments_schedule_idx').on(t.installmentScheduleId, t.status),
    check(
      'payments_amount_check',
      sql`${t.receivedAmount}>0 AND ${t.receivedAmount}<=1000000000000`,
    ),
    check('payments_status_check', sql`${t.status} IN ('received','voided')`),
    check(
      'payments_source_check',
      sql`${t.source} IN ('telegram','admin','installment','manual')`,
    ),
  ],
);

export const settlements = sqliteTable(
  'settlements',
  {
    id: text('id').primaryKey(),
    paymentId: text('payment_id')
      .notNull()
      .unique()
      .references(() => payments.id, { onDelete: 'restrict' }),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'restrict' }),
    collectorId: text('collector_id').references(() => collectors.id, {
      onDelete: 'restrict',
    }),
    receivedDate: text('received_date').notNull(),
    agentCodeSnapshot: text('agent_code_snapshot').notNull(),
    customerNameSnapshot: text('customer_name_snapshot').notNull(),
    receivedAmount: integer('received_amount').notNull(),
    commissionRate: real('commission_rate').notNull(),
    commissionAmount: integer('commission_amount').notNull(),
    returnAmount: integer('return_amount').notNull(),
    returnStatus: text('return_status', { enum: ['pending', 'returned'] })
      .notNull()
      .default('pending'),
    returnedAt: integer('returned_at', { mode: 'timestamp_ms' }),
    returnedByUserId: text('returned_by_user_id').references(() => user.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    version: integer('version').notNull().default(0),
    writeToken: text('write_token').notNull().default(''),
  },
  (t) => [
    index('settlements_date_status_idx').on(t.receivedDate, t.returnStatus),
    check(
      'settlement_amount_check',
      sql`${t.commissionRate} BETWEEN 0 AND 1 AND ${t.commissionAmount}>=0 AND ${t.returnAmount}>=0 AND ${t.commissionAmount}+${t.returnAmount}=${t.receivedAmount}`,
    ),
    check(
      'settlement_return_check',
      sql`(${t.returnStatus}='pending' AND ${t.returnedAt} IS NULL AND ${t.returnedByUserId} IS NULL) OR (${t.returnStatus}='returned' AND ${t.returnedAt} IS NOT NULL AND ${t.returnedByUserId} IS NOT NULL)`,
    ),
  ],
);

export const bulkAssignments = sqliteTable(
  'bulk_assignments',
  {
    id: text('id').primaryKey(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    collectorId: text('collector_id')
      .notNull()
      .references(() => collectors.id, { onDelete: 'restrict' }),
    routeId: text('route_id')
      .notNull()
      .references(() => telegramRoutes.id, { onDelete: 'restrict' }),
    request: text('request').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('bulk_assignments_actor_time_idx').on(t.createdByUserId, t.createdAt),
    check('bulk_assignments_json_check', sql`json_valid(${t.request})`),
  ],
);
export const bulkAssignmentItems = sqliteTable(
  'bulk_assignment_items',
  {
    id: text('id').primaryKey(),
    bulkAssignmentId: text('bulk_assignment_id')
      .notNull()
      .references(() => bulkAssignments.id, { onDelete: 'restrict' }),
    // Keep unknown/deleted request IDs as safe per-item outcomes, not dangling foreign keys.
    requestedCaseId: text('requested_case_id').notNull(),
    status: text('status', {
      enum: ['pending', 'assigned', 'skipped', 'failed'],
    })
      .notNull()
      .default('pending'),
    reason: text('reason'),
    assignmentId: text('assignment_id')
      .unique()
      .references(() => assignments.id, { onDelete: 'restrict' }),
    outboundJobId: text('outbound_job_id')
      .unique()
      .references(() => telegramOutboundJobs.id, { onDelete: 'restrict' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('bulk_assignment_case_idx').on(
      t.bulkAssignmentId,
      t.requestedCaseId,
    ),
    check(
      'bulk_assignment_item_status_check',
      sql`${t.status} IN ('pending','assigned','skipped','failed')`,
    ),
  ],
);

export const installmentWorkflows = sqliteTable(
  'installment_workflows',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'restrict' }),
    reportId: text('report_id')
      .notNull()
      .unique()
      .references(() => reports.id, { onDelete: 'restrict' }),
    assignmentId: text('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'restrict' }),
    collectorId: text('collector_id')
      .notNull()
      .references(() => collectors.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    telegramUserId: text('telegram_user_id').notNull(),
    routeId: text('route_id')
      .notNull()
      .references(() => telegramRoutes.id, { onDelete: 'restrict' }),
    step: text('step').notNull(),
    data: text('data').notNull().default('{}'),
    status: text('status', {
      enum: ['active', 'completed', 'cancelled', 'expired'],
    })
      .notNull()
      .default('active'),
    planId: text('plan_id').references(() => installmentPlans.id, {
      onDelete: 'restrict',
    }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    version: integer('version').notNull().default(0),
    lastUpdateId: text('last_update_id'),
    writeToken: text('write_token').notNull().default(''),
  },
  (t) => [
    uniqueIndex('workflow_active_sender_route_idx')
      .on(t.telegramUserId, t.routeId)
      .where(sql`${t.status}='active'`),
    index('workflow_expiry_idx').on(t.status, t.expiresAt),
    check('workflow_json_check', sql`json_valid(${t.data})`),
    check(
      'workflow_status_check',
      sql`${t.status} IN ('active','completed','cancelled','expired')`,
    ),
  ],
);
