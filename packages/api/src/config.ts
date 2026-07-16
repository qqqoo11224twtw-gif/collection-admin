import { authMode } from './auth';
import { publicProcedure } from './middleware';

/**
 * Pre-auth configuration probe for the web app. Reports the current
 * AUTH_MODE plus the NAMES of missing/misconfigured env vars — never values.
 * Public on purpose: the frontend needs the mode (mount the login UI or
 * not?) and the config hints before anyone can sign in.
 *
 * Severity follows the docs/auth.md matrix and is environment-aware. On a
 * DEPLOYED host, missing mail delivery means OTP codes can never reach
 * anyone — sign-in is impossible, so it BLOCKS (as does the dev-default
 * signing secret). On localhost the designed dev flow captures codes from
 * the server console / /api/dev/otp, so the same gaps are only warnings.
 */
export const configApi = {
  status: publicProcedure.handler(({ context }) => {
    const env = context.env;
    const mode = authMode();
    const isLocal = (env.SERVER_URL ?? '').startsWith('http://localhost');

    const missing: string[] = [];
    const warnings: string[] = [];

    if (mode !== 'disabled') {
      // ADMIN_EMAILS: in admin-only mode nobody can sign in without it —
      // blocks everywhere. In open mode customers can still sign in, but the
      // product has no admin channel — warn.
      const hasAdmins = (env.ADMIN_EMAILS ?? '')
        .split(',')
        .some((e) => e.trim().length > 0);
      if (!hasAdmins) {
        (mode === 'admin-only' ? missing : warnings).push('ADMIN_EMAILS');
      }

      // Mail delivery: deployed → OTPs are undeliverable, sign-in impossible.
      const mailGaps: string[] = [];
      if (!env.RESEND_API_KEY) mailGaps.push('RESEND_API_KEY');
      if (!env.EMAIL_FROM) mailGaps.push('EMAIL_FROM');
      (isLocal ? warnings : missing).push(...mailGaps);

      // Session signing secret still on the dev default.
      if (env.BETTER_AUTH_SECRET === 'local-dev-secret-not-for-prod') {
        (isLocal ? warnings : missing).push('BETTER_AUTH_SECRET');
      }
    }

    return {
      authMode: mode,
      mode: isLocal ? ('local' as const) : ('deployed' as const),
      missing,
      warnings,
    };
  }),
};
