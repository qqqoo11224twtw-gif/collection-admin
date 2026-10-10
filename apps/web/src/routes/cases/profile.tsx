import {
  PASSWORD_LENGTH_MESSAGE,
  PASSWORD_MIN_LENGTH,
} from '@saasflare-dev/api/password-policy';
import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { accountRequest } from '~/lib/managed-auth';
export const Route = createFileRoute('/cases/profile')({
  component: ProfilePage,
});
function ProfilePage() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [codes, setCodes] = useState<string[]>([]);
  async function submit(
    event: React.FormEvent<HTMLFormElement>,
    recovery = false,
  ) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const form = event.currentTarget;
    const data = new FormData(form);
    if (
      !recovery &&
      ['newPassword', 'confirmPassword'].some(
        (name) => String(data.get(name) ?? '').length < PASSWORD_MIN_LENGTH,
      )
    ) {
      setError(PASSWORD_LENGTH_MESSAGE);
      setBusy(false);
      return;
    }
    try {
      if (recovery) {
        const result = await accountRequest<{ recoveryCodes: string[] }>(
          'recovery-codes',
          {
            currentPassword: data.get('currentPassword'),
            code: data.get('code'),
          },
        );
        setCodes(result.recoveryCodes);
      } else {
        await accountRequest('change-password', {
          currentPassword: data.get('currentPassword'),
          newPassword: data.get('newPassword'),
          confirmPassword: data.get('confirmPassword'),
        });
        setNotice('密碼已更新，其他登入已撤銷。');
      }
      form.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失敗');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="max-w-xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">我的帳號</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          更新密碼與兩步驟驗證復原碼。
        </p>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <output className="block">{notice}</output>}
      <form
        onSubmit={(e) => void submit(e)}
        className="space-y-3 rounded-xl border bg-card p-5"
      >
        <h2 className="font-medium">變更密碼</h2>
        <Label htmlFor="currentPassword">目前密碼</Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
        <Label htmlFor="newPassword">新密碼</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          minLength={PASSWORD_MIN_LENGTH}
          onInvalid={(e) => {
            if (
              e.currentTarget.validity.tooShort ||
              e.currentTarget.validity.valueMissing
            )
              e.currentTarget.setCustomValidity(PASSWORD_LENGTH_MESSAGE);
          }}
          onInput={(e) => e.currentTarget.setCustomValidity('')}
          autoComplete="new-password"
          required
        />
        <Label htmlFor="confirmPassword">確認新密碼</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          minLength={PASSWORD_MIN_LENGTH}
          onInvalid={(e) => {
            if (
              e.currentTarget.validity.tooShort ||
              e.currentTarget.validity.valueMissing
            )
              e.currentTarget.setCustomValidity(PASSWORD_LENGTH_MESSAGE);
          }}
          onInput={(e) => e.currentTarget.setCustomValidity('')}
          autoComplete="new-password"
          required
        />
        <Button disabled={busy}>儲存新密碼</Button>
      </form>
      <form
        onSubmit={(e) => void submit(e, true)}
        className="space-y-3 rounded-xl border bg-card p-5"
      >
        <h2 className="font-medium">重新產生復原碼</h2>
        <p className="text-xs text-muted-foreground">
          重新產生後，舊復原碼立即失效。
        </p>
        <Label htmlFor="recoveryPassword">目前密碼</Label>
        <Input
          id="recoveryPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
        <Label htmlFor="recoveryCode">驗證器六位驗證碼</Label>
        <Input
          id="recoveryCode"
          name="code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          autoComplete="one-time-code"
          required
        />
        <Button disabled={busy}>產生復原碼</Button>
      </form>
      {codes.length > 0 && (
        <section className="space-y-3 rounded-xl border p-4">
          <p className="text-sm">只顯示一次，請安全保存。</p>
          <pre className="overflow-x-auto text-xs">{codes.join('\n')}</pre>
          <Button onClick={() => setCodes([])}>已安全保存</Button>
        </section>
      )}
    </div>
  );
}
