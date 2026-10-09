import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';
import {
  outboundPayloadSchema,
  type TelegramMessagePayload,
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
// Only fixed categories are logged; exception messages can contain the bot URL.
export function telegramExceptionKind(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'AbortError') return 'abort';
  if (name === 'TimeoutError') return 'timeout';
  if (/redirect/i.test(message)) return 'redirect';
  if (/AbortSignal|signal/i.test(message)) return 'signal';
  if (/DNS|resolve|hostname/i.test(message)) return 'dns';
  if (/TLS|SSL|certificate/i.test(message)) return 'tls';
  if (/network|fetch|connect/i.test(message)) return 'network';
  return 'other';
}
export interface TelegramClient {
  sendPhoto?(input: TelegramPhotoPayload): Promise<string>;
  sendMediaGroup?(input: TelegramPhotoPayload[]): Promise<string[]>;
  sendMessage(input: TelegramMessagePayload): Promise<string>;
  answerCallbackQuery(id: string, text: string): Promise<void>;
  downloadFile(
    fileId: string,
  ): Promise<{ bytes: ArrayBuffer; mediaType: string }>;
}
export interface TelegramPhotoPayload {
  chatId: string;
  topicId: number | null;
  caption: string;
  bytes: ArrayBuffer;
  mediaType: string;
  filename: string;
}
export class FakeTelegramClient implements TelegramClient {
  readonly photos: TelegramPhotoPayload[] = [];
  readonly albums: TelegramPhotoPayload[][] = [];
  async sendPhoto(input: TelegramPhotoPayload) {
    const id = await this.sendMessage({
      chatId: input.chatId,
      topicId: input.topicId,
      text: input.caption || '案件圖片',
    });
    this.photos.push(input);
    return id;
  }
  async sendMediaGroup(input: TelegramPhotoPayload[]) {
    if (input.length < 2 || input.length > 10)
      throw new TelegramFailure('INVALID_MEDIA_GROUP', false);
    const id = await this.sendMessage({
      chatId: input[0].chatId,
      topicId: input[0].topicId,
      text: input[0].caption,
    });
    this.albums.push(input);
    return input.map((_, i) => `${id}:${i}`);
  }
  readonly answered: { id: string; text: string }[] = [];
  async answerCallbackQuery(id: string, text: string) {
    this.answered.push({ id, text });
  }
  readonly sent: {
    chatId: string;
    topicId: number | null;
    text: string;
    id: string;
    replyMarkup?: TelegramMessagePayload['replyMarkup'];
  }[] = [];
  readonly downloads: string[] = [];
  sendFailures = 0;
  downloadFailures = 0;
  uncertainSend = false;
  async sendMessage(input: TelegramMessagePayload) {
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
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: 'POST',
          headers:
            input instanceof FormData
              ? undefined
              : { 'Content-Type': 'application/json' },
          body: input instanceof FormData ? input : JSON.stringify(input),
          signal: AbortSignal.timeout(10000),
          // Manual mode works in this Workers runtime and prevents token forwarding.
          redirect: 'manual',
        },
      );
    } catch (error: unknown) {
      const kind = telegramExceptionKind(error);
      console.warn('telegram.diagnostic', {
        stage:
          kind === 'abort' || kind === 'timeout'
            ? 'abort_timeout'
            : 'fetch_exception',
        method,
        kind,
        elapsedMs: Date.now() - started,
      });
      throw new TelegramFailure(
        send ? 'DELIVERY_UNKNOWN' : 'API_TIMEOUT',
        !send,
        send,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      console.warn('telegram.diagnostic', {
        stage: 'api_non_ok',
        method,
        httpStatus: response.status,
        apiCode: null,
      });
      throw new TelegramFailure(
        send ? 'DELIVERY_UNKNOWN' : 'API_REDIRECT',
        false,
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
      if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean')
        throw new Error('INVALID_API_RESPONSE');
    } catch {
      console.warn('telegram.diagnostic', {
        stage: 'invalid_json_response',
        method,
        httpStatus: response.status,
        elapsedMs: Date.now() - started,
      });
      throw new TelegramFailure(
        send ? 'DELIVERY_UNKNOWN' : 'INVALID_API_RESPONSE',
        !send,
        send,
      );
    }
    if (!body.ok) {
      const code = body.error_code ?? response.status;
      console.warn('telegram.diagnostic', {
        stage: 'api_non_ok',
        method,
        httpStatus: response.status,
        apiCode: typeof code === 'number' ? code : null,
      });
      throw new TelegramFailure(
        `API_${code}`,
        code === 429 || (!send && code >= 500),
        send && code >= 500,
        (body.parameters?.retry_after ?? 0) * 1000,
      );
    }
    return body.result;
  }
  async answerCallbackQuery(id: string, text: string) {
    await this.call('answerCallbackQuery', { callback_query_id: id, text });
  }
  async sendPhoto(input: TelegramPhotoPayload) {
    const form = new FormData();
    form.set('chat_id', input.chatId);
    if (input.topicId) form.set('message_thread_id', String(input.topicId));
    form.set('caption', input.caption);
    form.set(
      'photo',
      new Blob([input.bytes], { type: input.mediaType }),
      input.filename,
    );
    const result = (await this.call('sendPhoto', form, true)) as {
      message_id?: number;
    };
    if (!Number.isSafeInteger(result?.message_id))
      throw new TelegramFailure('DELIVERY_UNKNOWN', false, true);
    return String(result.message_id);
  }
  async sendMediaGroup(input: TelegramPhotoPayload[]) {
    if (input.length < 2 || input.length > 10)
      throw new TelegramFailure('INVALID_MEDIA_GROUP', false);
    const form = new FormData();
    form.set('chat_id', input[0].chatId);
    if (input[0].topicId)
      form.set('message_thread_id', String(input[0].topicId));
    const media = input.map((item, i) => {
      form.set(
        `photo${i}`,
        new Blob([item.bytes], { type: item.mediaType }),
        item.filename,
      );
      return {
        type: 'photo',
        media: `attach://photo${i}`,
        caption: item.caption || undefined,
      };
    });
    form.set('media', JSON.stringify(media));
    const result = (await this.call('sendMediaGroup', form, true)) as {
      message_id?: number;
    }[];
    if (
      !Array.isArray(result) ||
      result.length !== input.length ||
      result.some((v) => !Number.isSafeInteger(v?.message_id))
    )
      throw new TelegramFailure('DELIVERY_UNKNOWN', false, true);
    return result.map((v) => String(v.message_id));
  }
  async sendMessage(raw: TelegramMessagePayload) {
    const input = outboundPayloadSchema.parse(raw);
    const r = (await this.call(
      'sendMessage',
      {
        chat_id: input.chatId,
        message_thread_id: input.topicId ?? undefined,
        text: input.text,
        reply_markup: input.replyMarkup,
      },
      true,
    )) as { message_id?: number };
    if (!Number.isSafeInteger(r?.message_id)) {
      console.warn('telegram.diagnostic', {
        stage: 'missing_message_id',
        method: 'sendMessage',
      });
      throw new TelegramFailure('DELIVERY_UNKNOWN', false, true);
    }
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
        { signal: AbortSignal.timeout(10000), redirect: 'manual' },
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
