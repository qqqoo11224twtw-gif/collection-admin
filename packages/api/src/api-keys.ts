import { z } from 'zod';
import {
  API_KEY_MAX_EXPIRES_DAYS,
  createUserApiKey,
  listUserApiKeys,
  revokeUserApiKey,
} from './auth';
import { protectedProcedure } from './middleware';

/**
 * Managed API keys for the signed-in user (any user, not just admins — the
 * to-C story is "customers create their own keys"). The caller controls the
 * name and (optionally) an expiry in days — prefix and permissions are fixed
 * in the better-auth plugin config (auth.ts). The plugin scopes list/revoke
 * to the session user.
 */
export const apiKeysApi = {
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(64),
        // Omitted → the key never expires.
        expiresInDays: z
          .number()
          .int()
          .min(1)
          .max(API_KEY_MAX_EXPIRES_DAYS)
          .optional(),
      }),
    )
    .handler(({ context, input }) =>
      // The response is the ONLY place the full plaintext key ever appears.
      createUserApiKey(
        context.headers,
        input.name,
        input.expiresInDays ? input.expiresInDays * 24 * 60 * 60 : undefined,
      ),
    ),

  list: protectedProcedure.handler(({ context }) =>
    listUserApiKeys(context.headers),
  ),

  revoke: protectedProcedure
    .input(z.object({ keyId: z.string().min(1) }))
    .handler(({ context, input }) =>
      revokeUserApiKey(context.headers, input.keyId),
    ),
};
