import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';
import {
  outboundPayloadSchema,
  type TelegramSettings,
} from './telegram-contract';
export class TelegramFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly uncertain = false,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
export interface TelegramClient {
  sendMessage(input: {
    chatId: string;
    topicId: number | null;
    text: string;
  }): Promise<string>;
  downloadFile(
    fileId: string,
  ): Promise<{ bytes: ArrayBuffer; mediaType: string }>;
}
export class FakeTelegramClient implements TelegramClient {
  readonly sent: {
    chatId: string;
    topicId: number | null;
    text: string;
    id: string;
  }[] = [];
  readonly downloads: string[] = [];
  sendFailures = 0;
  downloadFailures = 0;
  uncertainSend = false;
  async sendMessage(input: {
    chatId: string;
    topicId: number | null;
    text: string;
  }) {
    outboundPayloadSchema.parse(input);
    if (this.sendFailures-- > 0) throw new TelegramFailure('RATE_LIMIT', true);
    const id = String(this.sent.length + 1);
    this.sent.push({ ...input, id });
    if (this.uncertainSend)
      throw new TelegramFailure('DELIVERY_UNKNOWN', false, true);
    return id;
  }
  async downloadFile(fileId: string) {
    this.downloads.push(fileId);
    if (this.downloadFailures-- > 0)
      throw new TelegramFailure('DOWNLOAD_TIMEOUT', true);
    return {
      bytes: Uint8Array.from(atob(DEMO_IMAGES[0].base64), (c) =>
        c.charCodeAt(0),
      ).buffer,
      mediaType: 'image/png',
    };
  }
}
export class BotApiTelegramClient implements TelegramClient {
  constructor(private readonly token: string) {}
  private async call(
    method: string,
    input: unknown,
    send = false,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        },
      );
    } catch {
      throw new TelegramFailure(
        send ? 'DELIVERY_UNKNOWN' : 'API_TIMEOUT',
        !send,
        send,
      );
    }
    let body: {
      ok?: boolean;
      result?: unknown;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    try {
      body = await response.json();
    } catch {
      throw new TelegramFailure(
        send ? 'DELIVERY_UNKNOWN' : 'INVALID_API_RESPONSE',
        !send,
        send,
      );
    }
    if (!body.ok) {
      const code = body.error_code ?? response.status;
      throw new TelegramFailure(
        `API_${code}`,
        code === 429 || (!send && code >= 500),
        send && code >= 500,
        (body.parameters?.retry_after ?? 0) * 1000,
      );
    }
    return body.result;
  }
  async sendMessage(raw: {
    chatId: string;
    topicId: number | null;
    text: string;
  }) {
    const input = outboundPayloadSchema.parse(raw);
    const r = (await this.call(
      'sendMessage',
      {
        chat_id: input.chatId,
        message_thread_id: input.topicId ?? undefined,
        text: input.text,
      },
      true,
    )) as { message_id?: number };
    if (!Number.isSafeInteger(r?.message_id))
      throw new TelegramFailure('DELIVERY_UNKNOWN', false, true);
    return String(r.message_id);
  }
  async downloadFile(fileId: string) {
    const file = (await this.call('getFile', { file_id: fileId })) as {
      file_path?: string;
      file_size?: number;
    };
    if (
      !file.file_path ||
      !/^[\w/.-]+$/.test(file.file_path) ||
      file.file_path.includes('..') ||
      (file.file_size ?? 0) > 5 * 1024 * 1024
    )
      throw new TelegramFailure('INVALID_FILE', false);
    try {
      const r = await fetch(
        `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        { signal: AbortSignal.timeout(10000), redirect: 'error' },
      );
      if (!r.ok) throw new TelegramFailure('DOWNLOAD_HTTP', true);
      const reader = r.body?.getReader();
      if (!reader) throw new TelegramFailure('INVALID_FILE', false);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 5 * 1024 * 1024) {
          await reader.cancel();
          throw new TelegramFailure('FILE_TOO_LARGE', false);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      return {
        bytes: bytes.buffer,
        mediaType:
          r.headers.get('content-type')?.split(';')[0] ??
          'application/octet-stream',
      };
    } catch (e: unknown) {
      if (e instanceof TelegramFailure) throw e;
      throw new TelegramFailure('DOWNLOAD_TIMEOUT', true);
    }
  }
}
const localClient = new FakeTelegramClient();
export function telegramClient(settings: TelegramSettings): TelegramClient {
  if (
    settings.TELEGRAM_MODE === 'fake' &&
    /^http:\/\/localhost(?::\d+)?\/?$/.test(settings.SERVER_URL ?? '')
  )
    return localClient;
  if (settings.TELEGRAM_MODE === 'live' && settings.TELEGRAM_BOT_TOKEN)
    return new BotApiTelegramClient(settings.TELEGRAM_BOT_TOKEN);
  throw new TelegramFailure('TELEGRAM_DISABLED', false);
}
