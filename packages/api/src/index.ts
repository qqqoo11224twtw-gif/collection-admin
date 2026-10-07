import type { RouterClient } from '@orpc/server';
import { apiKeysApi } from './api-keys';
import { caseManagementApi, collectorsApi } from './case-management';
import { caseMediaManagementApi } from './case-media-management';
import { casesApi } from './cases';
import { configApi } from './config';
import { connection, db, kv, r2 } from './health-check';
import { planetApi } from './planet';
import { caseLookupApi, reportsApi } from './reports';
import { reviewsApi } from './reviews';
import { storageApi } from './storage';
import { todosApi } from './todos';

export const appRouter = {
  cases: {
    ...casesApi,
    ...caseManagementApi,
    ...caseMediaManagementApi,
    lookup: caseLookupApi,
  },
  reports: reportsApi,
  reviews: reviewsApi,
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
