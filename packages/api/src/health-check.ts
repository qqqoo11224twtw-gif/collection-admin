import { ORPCError } from '@orpc/server';
import { publicProcedure as o } from './middleware';

export const connection = o.handler(({ context }) => {
  console.log('Env: ', context.env);
  return 'OK';
});

export const kv = o.handler(({ context }) => {
  if (!context.env.KV) {
    throw new ORPCError('NOT_FOUND', { message: 'KV not found' });
  }
  return 'OK';
});

export const db = o.handler(({ context }) => {
  if (!context.env.DB) {
    throw new ORPCError('NOT_FOUND', { message: 'DB not found' });
  }
  return 'OK';
});

export const r2 = o.handler(({ context }) => {
  if (!context.env.BUCKET) {
    throw new ORPCError('NOT_FOUND', {
      message:
        'Missing server env: `R2_ACCESS_KEY_ID` and/or `R2_SECRET_ACCESS_KEY`.',
    });
  }
  return 'OK';
});
