import { expect, it } from 'vitest';
import app from '../src/index';

it('unexpected errors expose neither stack, SQL nor credentials', async () => {
  app.get('/test-security-failure', () => {
    throw new Error(
      'SELECT private_data FROM hidden_table; credential=private-test-marker',
    );
  });
  const response = await app.request('http://localhost/test-security-failure');
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'INTERNAL_SERVER_ERROR' });
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
});

it('Telegram webhook rejects missing secret without a browser challenge', async () => {
  const response = await app.request('http://localhost/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(401);
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
});
