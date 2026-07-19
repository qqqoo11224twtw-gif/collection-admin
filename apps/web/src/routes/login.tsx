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
import { Loader2, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConfigStatus } from '~/components/config-notice';
import { authClient, useSession } from '~/lib/auth';
import { APP_DISPLAY_NAME } from '~/lib/brand';

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
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    setError(null);
    try {
      const { error: sendError } =
        await authClient.emailOtp.sendVerificationOtp({
          email: email.trim(),
          type: 'sign-in',
        });
      if (sendError) {
        // admin-only deployments reject non-whitelisted emails with
        // EMAIL_NOT_ADMIN before any code is sent.
        setError(
          sendError.code === 'EMAIL_NOT_ADMIN'
            ? 'This email is not an administrator account.'
            : (sendError.message ?? 'Could not send the code.'),
        );
        return;
      }
      setStep('otp');
      setOtp('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const { error: verifyError } = await authClient.signIn.emailOtp({
        email: email.trim(),
        otp: code,
      });
      if (verifyError) {
        setError(verifyError.message ?? 'Invalid or expired code.');
        setOtp('');
        return;
      }
      // Replace /login in history: Back after signing in should return to
      // wherever the user came from, not to a login form that would
      // immediately bounce them forward again.
      void navigate({ to: safeRedirect(redirect), replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  // AUTH_MODE=disabled deployments should delete this route; until then it
  // explains itself instead of a dead form (the server 404s /api/auth/*).
  if (authMode === 'disabled') {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Sign-in is disabled
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          This deployment runs with AUTH_MODE=disabled. See docs/auth.md to
          enable the login story.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/">Back to home</Link>
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
            <span className="grid size-12 place-items-center rounded-xl bg-foreground text-background">
              <Terminal className="size-6" />
            </span>
            <h1 className="text-xl font-semibold tracking-tight">
              {APP_DISPLAY_NAME}
            </h1>
            <p className="text-sm text-muted-foreground">
              {authMode === 'admin-only'
                ? 'Administrator sign-in'
                : 'Sign in or create your account with a one-time code'}
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
                      <FieldLabel htmlFor="email">Email</FieldLabel>
                      <Input
                        id="email"
                        type="email"
                        autoComplete="email"
                        autoFocus
                        placeholder="you@example.com"
                        aria-invalid={showEmailError || undefined}
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        onBlur={() => setEmailTouched(true)}
                      />
                      {showEmailError && (
                        <FieldDescription className="text-destructive">
                          Enter a valid email address.
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
                    disabled={busy || !emailValid}
                    type="submit"
                  >
                    {busy && <Loader2 size={16} className="animate-spin" />}
                    {busy ? 'Sending…' : 'Send code'}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    No password — we email you a 6-digit code.
                  </p>
                </CardFooter>
              </form>
            ) : (
              <>
                <CardContent>
                  <FieldGroup>
                    <Field data-invalid={!!error || undefined}>
                      <FieldLabel htmlFor="otp">
                        Enter the code sent to{' '}
                        <span className="font-medium text-foreground">
                          {email.trim()}
                        </span>
                      </FieldLabel>
                      <InputOTP
                        id="otp"
                        maxLength={6}
                        autoFocus
                        value={otp}
                        disabled={busy}
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
                          Local dev: the code is printed to the server console
                          (and at /api/dev/otp).
                        </FieldDescription>
                      )}
                    </Field>
                  </FieldGroup>
                </CardContent>
                <CardFooter className="flex-col gap-3 pt-6">
                  <Button
                    className="w-full"
                    disabled={busy || otp.length !== 6}
                    onClick={() => void verify(otp)}
                  >
                    {busy && <Loader2 size={16} className="animate-spin" />}
                    {busy ? 'Verifying…' : 'Verify and sign in'}
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
                      Use a different email
                    </button>
                    <button
                      type="button"
                      className="hover:text-foreground"
                      disabled={busy}
                      onClick={() => void sendCode()}
                    >
                      Resend code
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
