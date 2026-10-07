import type { RouterClient } from '@orpc/server';
import { apiKeysApi } from './api-keys';
import { casesApi } from './cases';
import { configApi } from './config';
import { connection, db, kv, r2 } from './health-check';
import { planetApi } from './planet';
import { storageApi } from './storage';
import { todosApi } from './todos';

export const appRouter = {
  cases: casesApi,
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
