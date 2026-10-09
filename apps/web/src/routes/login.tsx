import { Button } from '@saasflare-dev/ui/components/button';
import {
  Card,
  CardContent,
  CardFooter,
} from '@saasflare-dev/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@saasflare-dev/ui/components/field';
import { Input } from '@saasflare-dev/ui/components/input';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@saasflare-dev/ui/components/input-otp';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandLogo } from '~/components/brand-logo';
import { useConfigStatus } from '~/components/config-notice';
import { authClient, useSession } from '~/lib/auth';

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  component: LoginPage,
});

/**
 * Only same-app paths — never a full URL — to rule out open redirects.
 * /login itself is rejected too: a stale or nested redirect back to the
 * login page would bounce the user through it instead of landing home.
 */
function safeRedirect(target: string | undefined): string {
  if (
    target?.startsWith('/') &&
    !target.startsWith('//') &&
    !target.startsWith('/login')
  ) {
    return target;
  }
  return '/';
}

/** Pragmatic email shape check — the server is the real gate. */
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function LoginPage() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const { data: session, isPending } = useSession();
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Separate in-flight flags: resending a code must not spin the Verify
  // button, and verifying must not relabel the resend link.
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  // Seconds until "Resend code" unlocks. The server rate-limits OTP sends
  // (3/min/IP); the cooldown keeps normal users from ever hitting that wall.
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const configQuery = useConfigStatus();
  const authMode = configQuery.data?.authMode;
  const localMailMode =
    configQuery.data?.mode === 'local' &&
    configQuery.data.warnings.some(
      (v) => v === 'RESEND_API_KEY' || v === 'EMAIL_FROM',
    );

  const emailValid = isValidEmail(email);
  const showEmailError = emailTouched && email.length > 0 && !emailValid;

  // Already signed in → straight to the original destination. Replace, so
  // Back never lands on /login only to be bounced forward again.
  useEffect(() => {
    if (!isPending && session) {
      void navigate({ to: safeRedirect(redirect), replace: true });
    }
  }, [isPending, session, navigate, redirect]);

  const sendCode = async () => {
    // Hard gate: a malformed email never reaches the OTP step.
    if (!emailValid) {
      setEmailTouched(true);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const { error: sendError } =
        await authClient.emailOtp.sendVerificationOtp({
          email: email.trim(),
          type: 'sign-in',
        });
      if (sendError) {
        // The server checks the active allowlist before any code is generated.
        setError(
          ['EMAIL_NOT_ALLOWED', 'USER_INACTIVE', 'EMAIL_NOT_ADMIN'].includes(
            sendError.code ?? '',
          )
            ? '此帳號未被授權使用本系統。'
            : '無法寄送驗證碼，請稍後重試。',
        );
        return;
      }
      setStep('otp');
      setOtp('');
      setCooldown(60);
    } catch {
      setError('網路連線失敗，請重試。');
    } finally {
      setSending(false);
    }
  };

  const verify = async (code: string) => {
    setVerifying(true);
    setError(null);
    try {
      const { error: verifyError } = await authClient.signIn.emailOtp({
        email: email.trim(),
        otp: code,
      });
      if (verifyError) {
        setError('驗證碼錯誤或已過期。');
        setOtp('');
        return;
      }
      // Replace /login in history: Back after signing in should return to
      // wherever the user came from, not to a login form that would
      // immediately bounce them forward again.
      void navigate({ to: safeRedirect(redirect), replace: true });
    } catch {
      setError('網路連線失敗，請重試。');
    } finally {
      setVerifying(false);
    }
  };

  // AUTH_MODE=disabled deployments should delete this route; until then it
  // explains itself instead of a dead form (the server 404s /api/auth/*).
  if (authMode === 'disabled') {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">登入系統</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          此環境已停用登入功能，設定方式請參閱 docs/auth.md。
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/">返回首頁</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="flex min-h-svh flex-col bg-muted/30">
      <div className="flex flex-1 items-center justify-center p-5 pb-20">
        <div className="w-full max-w-sm">
          {/* Brand */}
          <div className="mb-8 flex flex-col items-center gap-2 text-center">
            <BrandLogo />
            <h1 className="text-2xl font-semibold tracking-tight">登入系統</h1>
            <p className="text-sm text-muted-foreground">
              安全、清楚、有效率的案件管理系統
            </p>
          </div>

          <Card className="shadow-sm">
            {step === 'email' ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendCode();
                }}
              >
                <CardContent>
                  <FieldGroup>
                    <Field data-invalid={showEmailError || undefined}>
                      <FieldLabel htmlFor="email">電子郵件</FieldLabel>
                      <Input
                        id="email"
                        type="email"
                        autoComplete="email"
                        autoFocus
                        placeholder="請輸入電子郵件"
                        aria-invalid={showEmailError || undefined}
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        onBlur={() => setEmailTouched(true)}
                      />
                      {showEmailError && (
                        <FieldDescription className="text-destructive">
                          請輸入有效的電子郵件地址。
                        </FieldDescription>
                      )}
                      {error && (
                        <FieldDescription className="text-destructive">
                          {error}
                        </FieldDescription>
                      )}
                    </Field>
                  </FieldGroup>
                </CardContent>
                <CardFooter className="flex-col gap-3 pt-6">
                  <Button
                    className="w-full"
                    disabled={sending || !emailValid}
                    type="submit"
                  >
                    {sending && <Loader2 size={16} className="animate-spin" />}
                    {sending ? '寄送中…' : '取得驗證碼'}
                  </Button>
                  <p className="text-center text-sm text-muted-foreground">
                    不需要密碼，系統會寄送 6 位數驗證碼。
                  </p>
                </CardFooter>
              </form>
            ) : (
              <>
                <CardContent>
                  <FieldGroup>
                    <Field data-invalid={!!error || undefined}>
                      <FieldLabel htmlFor="otp">
                        請輸入寄送至以下信箱的驗證碼：{' '}
                        <span className="font-medium text-foreground">
                          {email.trim()}
                        </span>
                      </FieldLabel>
                      <InputOTP
                        id="otp"
                        maxLength={6}
                        autoFocus
                        value={otp}
                        disabled={verifying}
                        data-testid="otp-input"
                        onChange={(value) => {
                          setOtp(value);
                          // Auto-submit on the 6th digit.
                          if (value.length === 6) void verify(value);
                        }}
                        containerClassName="justify-center py-2"
                      >
                        <InputOTPGroup>
                          {[0, 1, 2, 3, 4, 5].map((i) => (
                            <InputOTPSlot
                              key={i}
                              index={i}
                              className="h-11 w-11 text-base"
                            />
                          ))}
                        </InputOTPGroup>
                      </InputOTP>
                      {error && (
                        <FieldDescription className="text-center text-destructive">
                          {error}
                        </FieldDescription>
                      )}
                      {localMailMode && (
                        <FieldDescription className="text-center">
                          本機測試：驗證碼僅可從 /api/dev/otp 取得，不寫入日誌。
                        </FieldDescription>
                      )}
                    </Field>
                  </FieldGroup>
                </CardContent>
                <CardFooter className="flex-col gap-3 pt-6">
                  <Button
                    className="w-full"
                    disabled={verifying || otp.length !== 6}
                    onClick={() => void verify(otp)}
                  >
                    {verifying && (
                      <Loader2 size={16} className="animate-spin" />
                    )}
                    {verifying ? '驗證中…' : '登入系統'}
                  </Button>
                  <div className="flex w-full items-center justify-between text-xs text-muted-foreground">
                    <button
                      type="button"
                      className="hover:text-foreground"
                      onClick={() => {
                        setStep('email');
                        setOtp('');
                        setError(null);
                      }}
                    >
                      使用其他電子郵件
                    </button>
                    <button
                      type="button"
                      className="hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground"
                      disabled={sending || verifying || cooldown > 0}
                      onClick={() => void sendCode()}
                    >
                      {sending
                        ? '寄送中…'
                        : cooldown > 0
                          ? `重新寄送驗證碼（${cooldown} 秒）`
                          : '重新寄送驗證碼'}
                    </button>
                  </div>
                </CardFooter>
              </>
            )}
          </Card>
        </div>
      </div>
    </main>
  );
}
