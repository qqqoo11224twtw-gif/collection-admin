import type { RouterClient } from '@orpc/server';
import { accountsApi } from './accounts';
import { apiKeysApi } from './api-keys';
import { bulkAssignmentApi } from './bulk-assignment';
import { bulkCaseCreateApi } from './bulk-case-create';
import { bulkCaseEditApi } from './bulk-case-edit';
import { caseManagementApi, collectorsApi } from './case-management';
import { caseMediaManagementApi } from './case-media-management';
import { casesApi } from './cases';
import { clearingApi } from './collector-clearing';
import { collectorFinanceApi } from './collector-finance';
import { configApi } from './config';
import { financeApi } from './finance';
import { connection, db, kv, r2 } from './health-check';
import { installmentPriorityApi } from './installment-priority';
import { installmentTrackingApi } from './installment-tracking';
import { installmentsApi } from './installments';
import { intakeApi } from './intake';
import { manualCaseApi } from './manual-cases';
import { planetApi } from './planet';
import { caseLookupApi, reportsApi } from './reports';
import { reviewsApi } from './reviews';
import { storageApi } from './storage';
import { systemLogsApi } from './system-logs';
import { telegramApi } from './telegram';
import { telegramBotsApi } from './telegram-bots';
import { todosApi } from './todos';
import { usersApi } from './user-management';

export const appRouter = {
  accounts: accountsApi,
  users: usersApi,
  systemLogs: systemLogsApi,
  cases: {
    ...casesApi,
    ...caseManagementApi,
    ...bulkAssignmentApi,
    ...bulkCaseEditApi,
    ...bulkCaseCreateApi,
    ...caseMediaManagementApi,
    ...manualCaseApi,
    lookup: caseLookupApi,
  },
  reports: reportsApi,
  finance: financeApi,
  collectorFinance: collectorFinanceApi,
  clearing: clearingApi,
  installments: {
    ...installmentsApi,
    ...installmentPriorityApi,
    ...installmentTrackingApi,
  },
  reviews: reviewsApi,
  intake: intakeApi,
  telegram: { ...telegramApi, bots: telegramBotsApi },
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
