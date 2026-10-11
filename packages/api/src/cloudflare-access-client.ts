import { z } from 'zod';

export const accessEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);
const ruleSchema = z.record(z.string(), z.json());
export const accessGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  include: z.array(ruleSchema).max(1000),
  exclude: z.array(ruleSchema).default([]),
  require: z.array(ruleSchema).default([]),
  is_default: z.boolean().optional(),
  updated_at: z.string().optional(),
});
export type AccessGroup = z.infer<typeof accessGroupSchema>;
export class AccessFailure extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function groupRevision(group: AccessGroup) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(group)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export function groupEmails(group: AccessGroup) {
  // A dedicated exact-email group must never silently accept a domain/Everyone rule.
  if (group.is_default) throw new AccessFailure('ACCESS_UNSAFE_GROUP');
  const emails = group.include
    .map((rule) => {
      const parsed = z
        .strictObject({ email: z.strictObject({ email: accessEmailSchema }) })
        .safeParse(rule);
      if (!parsed.success) throw new AccessFailure('ACCESS_UNSAFE_GROUP');
      return parsed.data.email.email;
    })
    .sort();
  return [...new Set(emails)];
}
export interface AccessProvider {
  getGroup(): Promise<AccessGroup>;
  updateGroup(group: AccessGroup): Promise<void>;
  revokeUser(email: string): Promise<void>;
}
export class CloudflareAccessClient implements AccessProvider {
  private readonly root: string;
  constructor(
    accountId: string,
    private readonly groupId: string,
    private readonly token: string,
    private readonly request: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {
    if (
      !/^[a-f0-9]{32}$/.test(accountId) ||
      !z.uuid().safeParse(groupId).success ||
      !token
    )
      throw new AccessFailure('ACCESS_NOT_CONFIGURED');
    this.root = `https://api.cloudflare.com/client/v4/accounts/${accountId}/access`;
  }
  private async call(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    try {
      // Worker native fetch must not receive this client as its receiver.
      const request = this.request;
      const response = await request(`${this.root}/${path}`, {
        method,
        // Workers supports manual mode; never forward this token on redirects.
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const envelope = z
        .object({ success: z.literal(true), result: z.unknown() })
        .safeParse(await response.json());
      if (!response.ok || !envelope.success)
        throw new AccessFailure('ACCESS_PROVIDER_FAILED');
      return envelope.data.result;
    } catch {
      throw new AccessFailure('ACCESS_PROVIDER_FAILED');
    }
  }
  async getGroup() {
    const parsed = accessGroupSchema.safeParse(
      await this.call(`groups/${this.groupId}`),
    );
    if (!parsed.success || parsed.data.id !== this.groupId)
      throw new AccessFailure('ACCESS_PROVIDER_INVALID');
    groupEmails(parsed.data);
    return parsed.data;
  }
  async updateGroup(group: AccessGroup) {
    await this.call(`groups/${this.groupId}`, 'PUT', {
      name: group.name,
      include: group.include,
      exclude: group.exclude,
      require: group.require,
      ...(group.is_default === undefined
        ? {}
        : { is_default: group.is_default }),
    });
  }
  async revokeUser(email: string) {
    if (
      (await this.call('organizations/revoke_user', 'POST', {
        email: accessEmailSchema.parse(email),
      })) !== true
    )
      throw new AccessFailure('ACCESS_REVOKE_FAILED');
  }
  async inspectProtection(applicationId: string, hostname: string) {
    if (
      !z.uuid().safeParse(applicationId).success ||
      !hostname ||
      hostname.includes('/') ||
      hostname.startsWith('api.')
    )
      throw new AccessFailure('ACCESS_NOT_CONFIGURED');
    const object = z.record(z.string(), z.unknown());
    const app = object.parse(await this.call(`apps/${applicationId}`));
    const policies = z
      .array(object)
      .parse(await this.call(`apps/${applicationId}/policies`));
    const organization = object.parse(await this.call('organizations'));
    const identities = z
      .array(object)
      .parse(await this.call('identity_providers'));
    const otpIds = identities
      .filter((idp) => idp.type === 'onetimepin')
      .map((idp) => idp.id);
    const policy = policies[0];
    const validInclude =
      policy &&
      z
        .array(
          z.strictObject({
            group: z.strictObject({ id: z.literal(this.groupId) }),
          }),
        )
        .length(1)
        .safeParse(policy.include).success;
    const requireRule =
      policy &&
      z
        .array(
          z.strictObject({ login_method: z.strictObject({ id: z.string() }) }),
        )
        .length(1)
        .safeParse(policy.require);
    const otpRequired = !!(
      requireRule?.success &&
      otpIds.includes(requireRule.data[0].login_method.id)
    );
    const allowedIds = z.array(z.string()).safeParse(app.allowed_idps);
    const destinations = app.destinations;
    const scoped =
      app.domain === hostname &&
      (!Array.isArray(destinations) ||
        destinations.length === 0 ||
        destinations.every(
          (destination) =>
            object.safeParse(destination).success &&
            object.parse(destination).uri === hostname,
        ));
    return {
      hostname,
      exactHostnameOnly: scoped && app.type === 'self_hosted',
      soleAllowGroup:
        policies.length === 1 && policy.decision === 'allow' && !!validInclude,
      otpOnly:
        otpRequired &&
        allowedIds.success &&
        allowedIds.data.length === 1 &&
        otpIds.includes(allowedIds.data[0]),
      applicationSession:
        typeof app.session_duration === 'string'
          ? app.session_duration
          : 'unknown',
      policySession:
        typeof policy?.session_duration === 'string'
          ? policy.session_duration
          : 'unknown',
      globalSession:
        typeof organization.session_duration === 'string'
          ? organization.session_duration
          : 'unknown',
      allSessions720h:
        app.session_duration === '720h' &&
        policy?.session_duration === '720h' &&
        organization.session_duration === '720h',
      noDeviceSessionOverride:
        app.allow_authenticate_via_warp === false &&
        !app.warp_auth_session_duration,
    };
  }
}
