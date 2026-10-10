import {
  PASSWORD_LENGTH_MESSAGE,
  PASSWORD_MIN_LENGTH,
} from '@saasflare-dev/api/password-policy';
import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { createFileRoute } from '@tanstack/react-router';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { BrandLogo } from '~/components/brand-logo';
import { accountRequest } from '~/lib/managed-auth';
export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.redirect === 'string'
      ? { redirect: search.redirect }
      : ({} as { redirect?: string }),
  component: LoginPage,
});
function LoginPage() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
    if (new URLSearchParams(window.location.search).get('idle') === 'true')
      setError('已超過 15 分鐘未操作，請重新登入。');
  }, []);
  const { redirect } = Route.useSearch();
  const [step, setStep] = useState('login'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(() =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('idle') === 'true'
        ? '已超過 15 分鐘未操作，請重新登入。'
        : '',
    ),
    [qr, setQr] = useState(''),
    [secret, setSecret] = useState(''),
    [recovery, setRecovery] = useState<string[]>([]),
    [useRecovery, setUseRecovery] = useState(false);
  const finish = () => {
    window.location.assign(
      redirect?.startsWith('/') &&
        !redirect.startsWith('//') &&
        !redirect.startsWith('/login')
        ? redirect
        : '/cases',
    );
  };
  async function transition(next: string) {
    setStep(next);
    if (next === 'enroll') {
      const enrollment = await accountRequest<{ secret: string; uri: string }>(
        'onboarding/totp',
        {},
      );
      setSecret(enrollment.secret);
      setQr(await QRCode.toDataURL(enrollment.uri, { width: 220, margin: 2 }));
    }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    if (
      step === 'password_change' &&
      ['newPassword', 'confirmPassword'].some(
        (name) => String(data.get(name) ?? '').length < PASSWORD_MIN_LENGTH,
      )
    ) {
      setError(PASSWORD_LENGTH_MESSAGE);
      setBusy(false);
      return;
    }
    try {
      if (step === 'login') {
        const value = await accountRequest<{ step: string }>('login', {
          username: data.get('username'),
          password: data.get('password'),
        });
        await transition(value.step);
      } else if (step === 'password_change') {
        const value = await accountRequest<{ step: string }>(
          'onboarding/password',
          {
            newPassword: data.get('newPassword'),
            confirmPassword: data.get('confirmPassword'),
          },
        );
        await transition(value.step);
      } else {
        const value = await accountRequest<{ recoveryCodes?: string[] }>(
          useRecovery ? 'verify-recovery' : 'verify-totp',
          { code: data.get('code') },
        );
        setSecret('');
        setQr('');
        if (value.recoveryCodes) {
          setRecovery(value.recoveryCodes);
          setStep('recovery');
        } else finish();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '登入失敗');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main
      data-onboarding={step !== 'login'}
      className="flex min-h-dvh items-center justify-center bg-background p-5"
    >
      <section className="w-full max-w-sm space-y-6 rounded-2xl border bg-card p-6 shadow-lg">
        <BrandLogo />
        <div>
          <h1 className="text-2xl font-semibold">
            {step === 'login'
              ? '登入管理後台'
              : step === 'password_change'
                ? '設定新密碼'
                : step === 'enroll'
                  ? '綁定驗證器'
                  : step === 'recovery'
                    ? '保存復原碼'
                    : '兩步驟驗證'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {step === 'login'
              ? '使用管理員提供的帳號登入。'
              : step === 'password_change'
                ? '首次登入必須更換暫時密碼。密碼至少需要 6 碼。'
                : step === 'enroll'
                  ? '以 Google Authenticator 等驗證器掃描 QR Code。'
                  : '安全驗證完成前，無法操作後台。'}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {step === 'recovery' ? (
          <div className="space-y-4">
            <p className="text-sm">
              復原碼只顯示一次，每組只能使用一次。請保存至安全位置。
            </p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
              {recovery.join('\n')}
            </pre>
            <Button
              className="w-full"
              onClick={() => {
                setRecovery([]);
                finish();
              }}
            >
              已安全保存，進入後台
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {step === 'login' ? (
              <>
                <Label htmlFor="username">帳號</Label>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  required
                  maxLength={64}
                />
                <Label htmlFor="password">密碼</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </>
            ) : step === 'password_change' ? (
              <>
                <Label htmlFor="newPassword">新密碼</Label>
                <Input
                  id="newPassword"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  onInvalid={(e) => {
                    if (
                      e.currentTarget.validity.tooShort ||
                      e.currentTarget.validity.valueMissing
                    )
                      e.currentTarget.setCustomValidity(
                        PASSWORD_LENGTH_MESSAGE,
                      );
                  }}
                  onInput={(e) => e.currentTarget.setCustomValidity('')}
                  required
                />
                <Label htmlFor="confirmPassword">確認新密碼</Label>
                <Input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  onInvalid={(e) => {
                    if (
                      e.currentTarget.validity.tooShort ||
                      e.currentTarget.validity.valueMissing
                    )
                      e.currentTarget.setCustomValidity(
                        PASSWORD_LENGTH_MESSAGE,
                      );
                  }}
                  onInput={(e) => e.currentTarget.setCustomValidity('')}
                  required
                />
              </>
            ) : (
              <>
                {step === 'enroll' && (
                  <div className="space-y-3">
                    {qr && (
                      <img
                        src={qr}
                        alt="驗證器 QR Code"
                        className="mx-auto rounded-lg"
                      />
                    )}
                    <Label htmlFor="totpSecret">手動輸入金鑰</Label>
                    <Input
                      id="totpSecret"
                      value={secret}
                      readOnly
                      autoComplete="off"
                    />
                  </div>
                )}
                <Label htmlFor="code">
                  {useRecovery ? '復原碼' : '驗證器六位驗證碼'}
                </Label>
                <Input
                  id="code"
                  name="code"
                  autoComplete="one-time-code"
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  pattern={useRecovery ? undefined : '[0-9]{6}'}
                  required
                />
                {step === 'totp' && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setUseRecovery(!useRecovery)}
                  >
                    {useRecovery ? '改用驗證器' : '使用復原碼'}
                  </Button>
                )}
              </>
            )}
            <Button
              type="submit"
              className="h-11 w-full"
              disabled={busy || !ready || (step === 'enroll' && !secret)}
            >
              {busy
                ? '驗證中…'
                : step === 'login'
                  ? '登入'
                  : step === 'password_change'
                    ? '儲存新密碼'
                    : '驗證並登入'}
            </Button>
            {step !== 'login' && (
              <Button
                variant="ghost"
                className="w-full"
                type="button"
                onClick={() => {
                  setStep('login');
                  setSecret('');
                  setQr('');
                  setError('');
                }}
              >
                重新登入
              </Button>
            )}
          </form>
        )}
      </section>
    </main>
  );
}
