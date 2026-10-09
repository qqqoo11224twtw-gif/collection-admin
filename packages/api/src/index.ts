import type { RouterClient } from '@orpc/server';
import { apiKeysApi } from './api-keys';
import { bulkAssignmentApi } from './bulk-assignment';
import { caseManagementApi, collectorsApi } from './case-management';
import { caseMediaManagementApi } from './case-media-management';
import { casesApi } from './cases';
import { configApi } from './config';
import { financeApi } from './finance';
import { connection, db, kv, r2 } from './health-check';
import { installmentsApi } from './installments';
import { intakeApi } from './intake';
import { manualCaseApi } from './manual-cases';
import { planetApi } from './planet';
import { caseLookupApi, reportsApi } from './reports';
import { reviewsApi } from './reviews';
import { storageApi } from './storage';
import { systemLogsApi } from './system-logs';
import { telegramApi } from './telegram';
import { todosApi } from './todos';
import { usersApi } from './user-management';

export const appRouter = {
  users: usersApi,
  systemLogs: systemLogsApi,
  cases: {
    ...casesApi,
    ...caseManagementApi,
    ...bulkAssignmentApi,
    ...caseMediaManagementApi,
    ...manualCaseApi,
    lookup: caseLookupApi,
  },
  reports: reportsApi,
  finance: financeApi,
  installments: installmentsApi,
  reviews: reviewsApi,
  intake: intakeApi,
  telegram: telegramApi,
  collectors: collectorsApi,
  healthCheck: {
    connection,
    kv,
    db,
    r2,
  },
  config: configApi,
  todos: todosApi,
  storage: storageApi,
  planet: planetApi,
  apiKeys: apiKeysApi,
};

export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
