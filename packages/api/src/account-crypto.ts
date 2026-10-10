import { scryptAsync } from '@noble/hashes/scrypt.js';
import { z } from 'zod';
import type { Context } from './context';
import {
  PASSWORD_LENGTH_MESSAGE,
  PASSWORD_MIN_LENGTH,
} from './password-policy';

const utf8 = new TextEncoder();
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_LENGTH_MESSAGE);
export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .transform((value) => value.toLowerCase());
export const TOTP_STEP_SECONDS = 30;
export function bytesBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export function base64Bytes(value: string) {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
export function randomToken(size = 32) {
  return bytesBase64(crypto.getRandomValues(new Uint8Array(size)));
}
export async function digest(value: string) {
  return bytesBase64(
    new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(value))),
  );
}
export function constantEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++)
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
// OWASP's memory-hard scrypt alternative: N=2^15, r=8, p=3; no Workers PBKDF2 iteration cap.
export async function hashAccountPassword(password: string) {
  passwordSchema.parse(password);
  const salt = randomToken(16);
  const hash = await scryptAsync(password, salt, {
    N: 32768,
    r: 8,
    p: 3,
    dkLen: 32,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$8$3$${salt}$${bytesBase64(hash)}`;
}
export async function verifyAccountPassword(
  password: string,
  stored: string | null,
) {
  const fields = stored?.split('$');
  const valid =
    fields?.length === 6 &&
    fields[0] === 'scrypt' &&
    fields[1] === '32768' &&
    fields[2] === '8' &&
    fields[3] === '3' &&
    /^[\w-]{22}$/.test(fields[4]) &&
    /^[\w-]{43}$/.test(fields[5]);
  const salt = valid ? fields[4] : 'FictionalDummySaltValue';
  const hash = await scryptAsync(password, salt, {
    N: 32768,
    r: 8,
    p: 3,
    dkLen: 32,
    maxmem: 64 * 1024 * 1024,
  });
  return Boolean(valid && constantEqual(bytesBase64(hash), fields[5]));
}
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function encodeBase32(bytes: Uint8Array) {
  let bits = 0,
    value = 0,
    output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}
function decodeBase32(secret: string) {
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const c of secret) {
    const n = base32Alphabet.indexOf(c);
    if (n < 0) throw Error('INVALID_TOTP_SECRET');
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
export function newTotpSecret() {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(20)));
}
export async function totpCode(secret: string, counter: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase32(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setBigUint64(0, BigInt(counter));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, buffer),
  );
  const offset = signature[19] & 15;
  return String(
    (((signature[offset] & 127) << 24) |
      (signature[offset + 1] << 16) |
      (signature[offset + 2] << 8) |
      signature[offset + 3]) %
      1000000,
  ).padStart(6, '0');
}
export async function verifyTotp(
  secret: string,
  code: string,
  lastCounter = -1,
  time = Date.now(),
) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(time / 1000 / TOTP_STEP_SECONDS);
  for (const counter of [current, current - 1, current + 1])
    if (
      counter > lastCounter &&
      constantEqual(await totpCode(secret, counter), code)
    )
      return counter;
  return null;
}
export function isLocalAccountRuntime(env: Context['env']) {
  try {
    return ['localhost', '127.0.0.1'].includes(
      new URL(env.SERVER_URL).hostname,
    );
  } catch {
    return false;
  }
}
async function encryptionKey(env: Context['env'], version: string) {
  let raw: string | undefined;
  if (version === (env.ACCOUNT_TOTP_KEY_VERSION ?? 'v1'))
    raw = env.ACCOUNT_TOTP_ENCRYPTION_KEY;
  if (!raw && env.ACCOUNT_TOTP_ENCRYPTION_KEYS) {
    try {
      const keys: unknown = JSON.parse(env.ACCOUNT_TOTP_ENCRYPTION_KEYS);
      if (keys && typeof keys === 'object' && version in keys) {
        const value = (keys as Record<string, unknown>)[version];
        if (typeof value === 'string') raw = value;
      }
    } catch {
      throw Error('TOTP_ENCRYPTION_NOT_CONFIGURED');
    }
  }
  if (!raw && version === 'local-v1' && isLocalAccountRuntime(env)) {
    const bytes = await crypto.subtle.digest(
      'SHA-256',
      utf8.encode(`collection-admin:local-totp:${env.BETTER_AUTH_SECRET}`),
    );
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  }
  if (!raw) throw Error('TOTP_ENCRYPTION_NOT_CONFIGURED');
  const bytes = /^[a-fA-F0-9]{64}$/.test(raw)
    ? Uint8Array.from(raw.match(/../g) ?? [], (value) =>
        Number.parseInt(value, 16),
      )
    : base64Bytes(raw);
  if (bytes.length !== 32) throw Error('TOTP_ENCRYPTION_NOT_CONFIGURED');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
export async function encryptTotp(
  env: Context['env'],
  userId: string,
  secret: string,
) {
  const version = env.ACCOUNT_TOTP_ENCRYPTION_KEY
    ? (env.ACCOUNT_TOTP_KEY_VERSION ?? 'v1')
    : isLocalAccountRuntime(env)
      ? 'local-v1'
      : (env.ACCOUNT_TOTP_KEY_VERSION ?? 'v1');
  const key = await encryptionKey(env, version);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: utf8.encode(`${userId}:totp:${version}`),
    },
    key,
    utf8.encode(secret),
  );
  return {
    version,
    encrypted: JSON.stringify({
      iv: bytesBase64(iv),
      ciphertext: bytesBase64(new Uint8Array(encrypted)),
    }),
  };
}
export async function decryptTotp(
  env: Context['env'],
  userId: string,
  encrypted: string,
  version: string,
) {
  const data = z
    .strictObject({ iv: z.string().max(24), ciphertext: z.string().max(1024) })
    .parse(JSON.parse(encrypted));
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64Bytes(data.iv),
      additionalData: utf8.encode(`${userId}:totp:${version}`),
    },
    await encryptionKey(env, version),
    base64Bytes(data.ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}
