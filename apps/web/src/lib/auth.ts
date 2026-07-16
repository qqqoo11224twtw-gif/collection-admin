import { emailOTPClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * better-auth client in cookie mode. The server sets an httpOnly session
 * cookie; `credentials: 'include'` sends it on every cross-origin request
 * (web and server are separate workers). The emailOTP client plugin adds
 * `emailOtp.*` and `signIn.emailOtp`.
 */
export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
  baseURL: `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/auth`,
  fetchOptions: {
    credentials: 'include',
  },
});

export const { useSession, signOut } = authClient;
