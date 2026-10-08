import {
  BotApiTelegramClient,
  TelegramFailure,
  telegramExceptionKind,
} from '@saasflare-dev/api/telegram-client';
import { describe, expect, it, vi } from 'vitest';

describe('Telegram Bot API in the Workers runtime', () => {
  const client = new BotApiTelegramClient('000000:test-only-placeholder');
  const send = (text: string) =>
    client.sendMessage({ chatId: '-1001234567890', topicId: 2, text });
  it('reproduces the unsupported error redirect mode before network I/O', () => {
    expect(
      () => new Request('https://api.telegram.org/', { redirect: 'error' }),
    ).toThrow(/redirect/i);
  });
  it('manual redirect mode sends successfully and validates the message ID', async () => {
    expect(await send('fictional-success')).toBe('123');
  });
  it.each([
    'invalid-json',
    'null-json',
    'missing-id',
    'redirect',
  ])('preserves uncertain delivery without retry for %s', async (text) => {
    await expect(send(text)).rejects.toMatchObject({
      code: 'DELIVERY_UNKNOWN',
      retryable: false,
      uncertain: true,
    });
  });
  it('explicit 429 remains safe to retry with its server delay', async () => {
    await expect(send('rate-limit')).rejects.toMatchObject({
      code: 'API_429',
      retryable: true,
      uncertain: false,
      retryAfterMs: 2000,
    });
  });
  it('server failure remains uncertain and cannot be blindly retried', async () => {
    await expect(send('server-error')).rejects.toMatchObject({
      code: 'API_500',
      retryable: false,
      uncertain: true,
    });
  });
  it('classifies exceptions using fixed categories without returning URLs or secrets', () => {
    expect(
      telegramExceptionKind(new DOMException('secret', 'AbortError')),
    ).toBe('abort');
    expect(
      telegramExceptionKind(new DOMException('secret', 'TimeoutError')),
    ).toBe('timeout');
    expect(telegramExceptionKind(new Error('redirect secret'))).toBe(
      'redirect',
    );
    expect(
      telegramExceptionKind(
        new Error('fetch https://api.telegram.org/botSECRET/sendMessage'),
      ),
    ).toBe('network');
    expect(telegramExceptionKind(new TelegramFailure('TEST', false))).toBe(
      'other',
    );
  });
  it('logs only diagnostic categories, never bot URL, token, chat or payload', async () => {
    const logs = vi.spyOn(console, 'warn');
    try {
      await expect(send('invalid-json')).rejects.toBeInstanceOf(
        TelegramFailure,
      );
      await expect(send('missing-id')).rejects.toBeInstanceOf(TelegramFailure);
      await expect(send('rate-limit')).rejects.toBeInstanceOf(TelegramFailure);
      expect(logs.mock.calls.map((call) => call[1]?.stage)).toEqual([
        'invalid_json_response',
        'missing_message_id',
        'api_non_ok',
      ]);
      const output = JSON.stringify(logs.mock.calls);
      for (const sensitive of [
        '000000:test-only-placeholder',
        'api.telegram.org',
        '-1001234567890',
        'invalid-json',
      ])
        expect(output).not.toContain(sensitive);
    } finally {
      logs.mockRestore();
    }
  });
});
