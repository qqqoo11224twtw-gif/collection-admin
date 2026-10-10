import { env } from 'cloudflare:workers';
import { ORPCError } from '@orpc/server';
import { managedAuthEnabled, managedSession } from './managed-auth';
// The legacy API-key plugin remains an implementation detail, never a login route.
export async function apiKeySessionHeaders(headers: Headers) {
  if (!managedAuthEnabled()) return headers;
  const info = await managedSession(headers);
  if (!info) throw new ORPCError('UNAUTHORIZED');
  const now = Date.now(),
    id = `managed:${info.session.id}`;
  await env.DB.prepare(
    `INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_sessions s JOIN user u ON u.id=s.user_id WHERE s.id=? AND s.auth_version=u.auth_version AND u.active=1 AND u.deleted_at IS NULL AND u.must_change_password=0 AND u.totp_enabled=1) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
  )
    .bind(
      id,
      info.user.id,
      info.session.token,
      info.session.expiresAt.getTime(),
      now,
      now,
      info.session.id,
    )
    .run();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(info.session.token),
  );
  const signed = encodeURIComponent(
    `${info.session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
  );
  const result = new Headers(headers);
  result.set(
    'Cookie',
    `${env.SERVER_URL.startsWith('https://') ? '__Secure-' : ''}better-auth.session_token=${signed}`,
  );
  return result;
}
