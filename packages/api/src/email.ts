import { env } from 'cloudflare:workers';
import { systemLog } from './system-log';

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
 * closed at deploy time in alchemy.run.ts), the code remains accessible only
 * through the localhost test endpoint. Send failures
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
    await systemLog(env.DB, {
      category: 'otp',
      event: 'OTP_SENT',
      safeMessage: '本機驗證碼已準備，可由測試端點取得。',
    });
    return;
  }

  // EMAIL_FROM must be a verified Resend sender domain.
  const from = env.EMAIL_FROM || 'Starter <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) {
      // Reject failed delivery without retaining provider bodies or the OTP.
      throw new Error('OTP_SEND_FAILED');
    }
    await systemLog(env.DB, { category: 'otp', event: 'OTP_SENT' });
  } catch {
    await systemLog(env.DB, {
      category: 'otp',
      event: 'OTP_SEND_FAILED',
      level: 'error',
      status: 'failed',
      errorCode: 'OTP_SEND_FAILED',
    });
    throw new Error('OTP_SEND_FAILED');
  }
}
