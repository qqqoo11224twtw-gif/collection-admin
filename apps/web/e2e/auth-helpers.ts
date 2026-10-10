import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

/** Local-only fictional managed accounts; never enrolls a real staging user. */

export const USER_EMAIL = 'e2e-user@test.dev';
export const SERVER_URL = 'http://localhost:4000';

/** True when running against a deployed URL (no dev OTP endpoint there). */
export const isRemote = !!process.env.PLAYWRIGHT_BASE_URL;

/**
 * Type into a controlled input, retrying until React state catches up.
 * The login page is SSR'd: a fill() that lands before hydration never fires
 * onChange, so the submit button stays disabled — retype until it enables.
 */
export async function fillUntilEnabled(
  page: Page,
  placeholder: string,
  value: string,
  buttonName: RegExp,
): Promise<void> {
  const input = page.getByPlaceholder(placeholder);
  await expect(input).toBeVisible();
  await expect(async () => {
    await input.fill(value);
    await expect(page.getByRole('button', { name: buttonName })).toBeEnabled({
      timeout: 1000,
    });
  }).toPass({ timeout: 15000 });
}

/** Fixtures exist only in local D1; no public account creation endpoint. */
export async function signIn(page: Page, email = USER_EMAIL): Promise<void> {
  const initialURL = new URL(page.url());
  const returnTo =
    initialURL.pathname !== '/login'
      ? initialURL.pathname + initialURL.search
      : undefined;
  if (isRemote)
    throw Error('Managed login E2E only uses local fictional accounts');
  const dir = new URL('../../server/.wrangler/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const safe = email.replaceAll("'", "''"),
    username = `e2e-${email.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
    password = 'Fictional-E2E-password-2026!',
    salt = randomBytes(16).toString('base64url'),
    hash =
      'scrypt$32768$8$3$' +
      salt +
      '$' +
      scryptSync(password, salt, 32, {
        N: 32768,
        r: 8,
        p: 3,
        maxmem: 64 * 1024 * 1024,
      }).toString('base64url'),
    now = Date.now(),
    admin = /^(admin|phase[2-8]-admin)@example\.test$/.test(email);
  writeFileSync(
    new URL('e2e-user.sql', dir),
    `INSERT INTO user(id,name,email,email_verified,username,password_hash,must_change_password,totp_enabled,last_totp_counter,role,created_at,updated_at) VALUES ('${crypto.randomUUID()}','虛構測試帳號','${safe}',0,'${username}','${hash}',0,0,-1,'${admin ? 'admin' : 'user'}',${now},${now}) ON CONFLICT(email) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,must_change_password=0,totp_enabled=0,totp_encrypted=NULL,totp_key_version=NULL,last_totp_counter=-1,active=1,deleted_at=NULL,auth_version=auth_version+1;`,
  );
  await expect(async () =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            '../../../node_modules/wrangler/bin/wrangler.js',
            import.meta.url,
          ),
        ),
        'd1',
        'execute',
        'starter-local-db',
        '--local',
        '--config',
        'wrangler.local.jsonc',
        '--file',
        '.wrangler/e2e-user.sql',
      ],
      {
        cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
        stdio: 'pipe',
        windowsHide: true,
      },
    ),
  ).toPass({ timeout: 15000 });
  await expect(async () => {
    if (!new URL(page.url()).pathname.startsWith('/login'))
      await page.goto(
        returnTo ? `/login?redirect=${encodeURIComponent(returnTo)}` : '/login',
      );
    await expect(page.getByLabel('帳號', { exact: true })).toBeVisible();
  }).toPass({ timeout: 15000 });
  // The SSR fields are visible before hydration; wait for the login readiness
  // gate before filling so hydration cannot discard the test's input.
  await expect(
    page.getByRole('button', { name: '登入', exact: true }),
  ).toBeEnabled();
  await page.getByLabel('帳號', { exact: true }).fill(username);
  await page.getByLabel('密碼', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await completeEnrollment(page);
}
export async function completeEnrollment(page: Page) {
  const secretInput = page.getByLabel('手動輸入金鑰');
  await expect(secretInput).toBeVisible({ timeout: 30000 });
  await expect(secretInput).toHaveValue(/^[A-Z2-7]{32}$/, { timeout: 15000 });
  const secret = await secretInput.inputValue();
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const c of secret) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(buffer).digest(),
    offset = mac[19] & 15,
    code = String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
      6,
      '0',
    );
  await page.getByLabel('驗證器六位驗證碼').fill(code);
  await page.getByRole('button', { name: '驗證並登入' }).click();
  await page.getByRole('button', { name: '已安全保存，進入後台' }).click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
}
export async function configureCaseFinance(page: Page, caseId: string) {
  const rpc = async (method: string, input: unknown) => {
    const response = await page.request.post(
      `${SERVER_URL}/rpc/${method.replaceAll('.', '/')}`,
      { data: { json: input } },
    );
    expect(response.status()).toBe(200);
    return (await response.json()).json;
  };
  const collector = await rpc('collectors.create', {
    displayName: '虛構分期驗收外收',
    code: `SCHEDULE-${Date.now()}`,
    userId: null,
    isActive: true,
  });
  for (const [kind, rate] of [['return', 0.5]] as const) {
    const settings = await rpc('collectorFinance.settings', {});
    await rpc('collectorFinance.setRate', {
      collectorId: collector.id,
      kind,
      rate,
      expectedVersion: settings.version,
    });
  }
  // Local fixture only: this case has no previous assignment to correct.
  if (!/^[0-9a-f-]{36}$/.test(caseId) || !/^[0-9a-f-]{36}$/.test(collector.id))
    throw Error('Invalid local fixture identifier');
  const file = new URL(
    '../../server/.wrangler/e2e-finance-assignment.sql',
    import.meta.url,
  );
  writeFileSync(
    file,
    `INSERT INTO assignments(id,case_id,collector_id,assigned_by_user_id,assigned_at,record_type,note,correction_reason) SELECT '${crypto.randomUUID()}','${caseId}','${collector.id}',id,${Date.now()},'historical','Local fictional fixture; no outbound','Local fictional fixture' FROM user WHERE username='e2e-phase8-admin-example-test';`,
  );
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          '../../../node_modules/wrangler/bin/wrangler.js',
          import.meta.url,
        ),
      ),
      'd1',
      'execute',
      'starter-local-db',
      '--local',
      '--config',
      'wrangler.local.jsonc',
      '--file',
      fileURLToPath(file),
    ],
    {
      cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
      stdio: 'pipe',
      windowsHide: true,
    },
  );
}
