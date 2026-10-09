import { ORPCError } from '@orpc/server';

function decode(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function encode(value: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}
async function key(raw?: string) {
  try {
    const bytes = decode(raw ?? '');
    if (bytes.length !== 32) throw new Error();
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: '機器人加密設定未完成。',
    });
  }
}
export async function encryptBotToken(
  token: string,
  recordId: string,
  master?: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(`telegram-bot:v1:${recordId}`),
    },
    await key(master),
    new TextEncoder().encode(token),
  );
  return {
    ciphertext: encode(ciphertext),
    nonce: encode(iv),
    encryptionVersion: 1,
  };
}
export async function decryptBotToken(
  record: {
    id: string;
    ciphertext: string;
    nonce: string;
    encryptionVersion: number;
  },
  master?: string,
) {
  try {
    if (record.encryptionVersion !== 1) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decode(record.nonce),
        additionalData: new TextEncoder().encode(
          `telegram-bot:v1:${record.id}`,
        ),
      },
      await key(master),
      decode(record.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: '機器人加密設定無法使用。',
    });
  }
}
