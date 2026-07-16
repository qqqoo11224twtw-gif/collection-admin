import { env } from 'cloudflare:workers';

interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
}

/**
 * Minimal transactional email sender.
 *
 * With RESEND_API_KEY set, sends via Resend's REST API (no SDK dependency).
 * Without it (local dev / tests only — deployed auth-enabled stages fail
 * closed at deploy time in alchemy.run.ts), logs the message to the worker
 * console so the OTP code is still reachable during testing. Send failures
 * are logged WITHOUT the message body so an OTP never reaches production
 * logs.
 */
export async function sendEmail({
  to,
  subject,
  text,
}: SendEmailInput): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      `[email:dev] no RESEND_API_KEY — would send to ${to}\n  subject: ${subject}\n  ${text}`,
    );
    return;
  }

  // EMAIL_FROM must be a verified Resend sender domain.
  const from = env.EMAIL_FROM || 'Starter <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!res.ok) {
    // Don't throw: a failed email must not 500 the auth request. Log status
    // only — never the body, which contains the OTP.
    console.error('resend send failed', res.status, await res.text());
  }
}
