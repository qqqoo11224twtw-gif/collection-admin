import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { displayError } from '~/components/cases/display-labels';
import {
  type Permission,
  useCasePermissions,
} from '~/components/cases/management-hooks';
import { permissionLabels } from '~/components/cases/permission-labels';
import { orpc } from '~/lib/orpc';
export const Route = createFileRoute('/cases/users')({
  component: AccountsPage,
});
const groups = [
  ['案件管理', ['case.', 'media.', 'report.']],
  ['委外調度', ['assignment.', 'collector.']],
  ['人工確認', ['review.', 'intake.']],
  ['收款與分期', ['payment.', 'installment.']],
  ['財務交收', ['settlement.', 'finance.']],
  ['Telegram 管理', ['telegram_']],
  ['系統管理', ['user_permission.', 'system_log.', 'audit.', 'audit_log.']],
] as const;
function AccountsPage() {
  const permissions = useCasePermissions(),
    qc = useQueryClient();
  const list = useQuery({
    ...orpc.accounts.list.queryOptions({ input: { includeDeleted: false } }),
    enabled: permissions.can('user_permission.manage'),
  });
  const keys = useQuery({
    ...orpc.users.keys.queryOptions(),
    enabled: permissions.can('user_permission.manage'),
  });
  const collectors = useQuery({
    ...orpc.accounts.collectorChoices.queryOptions(),
    enabled: permissions.can('user_permission.manage'),
  });
  const save = useMutation(orpc.accounts.save.mutationOptions()),
    action = useMutation(orpc.accounts.action.mutationOptions());
  const [open, setOpen] = useState(false),
    [id, setId] = useState<string | undefined>(),
    [role, setRole] = useState<
      'admin' | 'manager' | 'user' | 'reviewer' | 'finance' | 'restricted'
    >('restricted'),
    [allow, setAllow] = useState<Permission[]>([]),
    [deny, setDeny] = useState<Permission[]>([]),
    [error, setError] = useState(''),
    [temporary, setTemporary] = useState('');
  const editing = list.data?.find((r) => r.id === id);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setError('');
    try {
      const result = await save.mutateAsync({
        id,
        username: String(data.get('username')),
        name: String(data.get('name')),
        role,
        active: data.get('active') === 'on',
        collectorId: String(data.get('collectorId') || '') || null,
        allow,
        deny,
        expectedVersion: editing?.version ?? 0,
      });
      setTemporary(result.temporaryPassword ?? '');
      setOpen(false);
      await qc.invalidateQueries();
    } catch (error) {
      setError(displayError(error, '帳號儲存失敗，請檢查輸入。'));
    }
  }
  if (!permissions.can('user_permission.manage')) return <p>無操作權限</p>;
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">帳號管理</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            管理員建立帳號；首次登入需換密碼並綁定驗證器。停用及刪除會撤銷登入。
          </p>
        </div>
        <Button
          onClick={() => {
            setId(undefined);
            setRole('restricted');
            setAllow([]);
            setDeny([]);
            setOpen(true);
            setError('');
          }}
        >
          新增帳號
        </Button>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {temporary && (
        <section className="space-y-3 rounded-xl border bg-card p-5">
          <h2 className="font-medium">一次性暫時密碼</h2>
          <p className="text-sm">
            只顯示一次，請透過安全方式交付使用者。不要貼到公開群組。
          </p>
          <Input
            aria-label="一次性暫時密碼"
            value={temporary}
            readOnly
            autoComplete="off"
          />
          <Button
            onClick={() => {
              setTemporary('');
              save.reset();
              action.reset();
            }}
          >
            已安全交付
          </Button>
        </section>
      )}
      {open && (
        <form
          key={id ?? 'new'}
          onSubmit={submit}
          className="space-y-4 rounded-xl border bg-card p-5"
        >
          <h2 className="font-medium">{id ? '編輯帳號' : '新增帳號'}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="accountUsername">帳號</Label>
              <Input
                id="accountUsername"
                name="username"
                defaultValue={editing?.username ?? ''}
                required
                minLength={3}
                maxLength={64}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="accountName">顯示名稱</Label>
              <Input
                id="accountName"
                name="name"
                defaultValue={editing?.name ?? ''}
                required
                maxLength={120}
              />
            </div>
            <div>
              <Label htmlFor="accountRole">角色範本</Label>
              <select
                id="accountRole"
                className="h-10 w-full rounded-md border bg-background px-3"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as typeof role);
                  setAllow([]);
                  setDeny([]);
                }}
              >
                {[
                  ['admin', '管理員'],
                  ['user', '外收人員'],
                  ['finance', '財務'],
                  ['restricted', '自訂'],
                  ['manager', '業務管理'],
                  ['reviewer', '審核人員'],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="accountCollector">綁定外收人員</Label>
              <select
                id="accountCollector"
                name="collectorId"
                defaultValue={editing?.collectorId ?? ''}
                required={role === 'user'}
                className="h-10 w-full rounded-md border bg-background px-3"
              >
                <option value="">不綁定</option>
                {collectors.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="active"
              defaultChecked={editing?.active ?? true}
            />
            啟用帳號
          </label>
          <section className="space-y-3">
            <h3 className="font-medium">權限群組覆寫</h3>
            <p className="text-xs text-muted-foreground">
              角色提供預設權限；群組可額外允許或拒絕，拒絕優先。財務角色預設僅管理財務。
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {groups.map(([label, prefixes]) => {
                const members =
                  keys.data?.filter(
                    (key) =>
                      key !== 'finance.settings.manage' &&
                      prefixes.some((prefix) => key.startsWith(prefix)),
                  ) ?? [];
                return (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-2 rounded-lg border p-3"
                  >
                    <span className="text-sm">{label}</span>
                    <select
                      aria-label={`${label}權限`}
                      className="rounded-md border bg-background p-2 text-sm"
                      value={
                        members.every((k) => allow.includes(k)) &&
                        members.length
                          ? 'allow'
                          : members.every((k) => deny.includes(k)) &&
                              members.length
                            ? 'deny'
                            : 'inherit'
                      }
                      onChange={(e) => {
                        setAllow((previous) => [
                          ...previous.filter(
                            (k) =>
                              !members.includes(k) &&
                              (label !== '財務交收' ||
                                k !== 'finance.settings.manage'),
                          ),
                          ...(e.target.value === 'allow' ? members : []),
                        ]);
                        setDeny((previous) => [
                          ...previous.filter((k) => !members.includes(k)),
                          ...(e.target.value === 'deny' ? members : []),
                        ]);
                      }}
                    >
                      <option value="inherit">角色預設</option>
                      <option value="allow">允許</option>
                      <option value="deny">拒絕</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </section>
          <details>
            <summary className="cursor-pointer text-sm">進階權限</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {keys.data?.map((key) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-2 rounded-lg border p-2 text-xs"
                >
                  <span>{permissionLabels[key] ?? key}</span>
                  <select
                    aria-label={key}
                    className="bg-background"
                    value={
                      deny.includes(key)
                        ? 'deny'
                        : allow.includes(key)
                          ? 'allow'
                          : 'inherit'
                    }
                    onChange={(e) => {
                      setAllow((previous) => [
                        ...previous.filter((k) => k !== key),
                        ...(e.target.value === 'allow' ? [key] : []),
                      ]);
                      setDeny((previous) => [
                        ...previous.filter((k) => k !== key),
                        ...(e.target.value === 'deny' ? [key] : []),
                      ]);
                    }}
                  >
                    <option value="inherit">預設</option>
                    <option value="allow">允許</option>
                    <option value="deny">拒絕</option>
                  </select>
                </label>
              ))}
            </div>
          </details>
          <div className="flex gap-2">
            <Button disabled={save.isPending}>儲存變更</Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
          </div>
        </form>
      )}
      {list.isPending ? (
        <p>載入中…</p>
      ) : list.isError ? (
        <p role="alert">帳號載入失敗</p>
      ) : (
        <div className="space-y-3">
          {list.data.map((row) => (
            <article key={row.id} className="rounded-xl border bg-card p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <h2 className="font-medium">
                    {row.name} · {row.username ?? '待遷移'}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {(
                      {
                        admin: '管理員',
                        manager: '業務管理',
                        user: '外收人員',
                        reviewer: '審核人員',
                        finance: '財務',
                        restricted: '自訂',
                      } as Record<string, string>
                    )[row.role] ?? row.role}{' '}
                    · {row.active ? '啟用' : '停用'} ·{' '}
                    {row.totpEnabled ? '已綁定驗證器' : '待綁定驗證器'} ·{' '}
                    {row.mustChangePassword ? '需換密碼' : '密碼已設定'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    setId(row.id);
                    setRole(row.role as typeof role);
                    setAllow(row.allow);
                    setDeny(row.deny);
                    setOpen(true);
                  }}
                >
                  修改
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[
                  [
                    row.active ? 'disable' : 'enable',
                    row.active ? '停用' : '啟用',
                  ],
                  ['reset_password', '重設密碼'],
                  ['reset_totp', '重設 2FA'],
                  ['revoke_sessions', '撤銷 Session'],
                  ['delete', '刪除帳號'],
                ].map(([value, label]) => (
                  <Button
                    key={value}
                    variant="ghost"
                    size="sm"
                    disabled={action.isPending}
                    onClick={async () => {
                      if (!window.confirm(`確定${label}？既有操作歷史會保留。`))
                        return;
                      try {
                        const result = await action.mutateAsync({
                          id: row.id,
                          action: value as 'disable',
                          expectedVersion: row.version,
                        });
                        setTemporary(result.temporaryPassword ?? '');
                        await qc.invalidateQueries();
                      } catch (e) {
                        setError(displayError(e, '帳號操作失敗，請重新確認。'));
                      }
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
