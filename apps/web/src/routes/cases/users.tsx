import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@saasflare-dev/ui/components/dialog';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { DialogContent } from '~/components/cases/localized-dialog';
import {
  type Permission,
  useCasePermissions,
} from '~/components/cases/management-hooks';
import { permissionLabels } from '~/components/cases/permission-labels';
import { orpc } from '~/lib/orpc';
export const Route = createFileRoute('/cases/users')({ component: UsersPage });
function UsersPage() {
  const permissions = useCasePermissions(),
    qc = useQueryClient();
  const list = useQuery({
    ...orpc.users.list.queryOptions(),
    enabled: permissions.can('user_permission.manage'),
  });
  const keys = useQuery({
    ...orpc.users.keys.queryOptions(),
    enabled: permissions.can('user_permission.manage'),
  });
  const [editing, setEditing] = useState<string | null>(null),
    [error, setError] = useState('');
  const save = useMutation(
    orpc.users.save.mutationOptions({
      onSuccess: () => {
        setEditing(null);
        void qc.invalidateQueries();
        setError('');
      },
      onError: (e) => setError(e.message),
    }),
  );
  if (permissions.isPending) return <p>載入中…</p>;
  if (!permissions.can('user_permission.manage')) return <p>無操作權限</p>;
  const row = list.data?.find((u) => u.id === editing);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">使用者與權限</h1>
      <p className="text-sm text-muted-foreground">
        此處同時管理 Email
        白名單，只有啟用中的帳號可取得驗證碼。角色提供預設權限，個人拒絕優先於允許。
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {list.isError ? (
        <p>使用者載入失敗</p>
      ) : list.isPending ? (
        <p>載入中…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.data?.map((u) => (
            <button
              type="button"
              key={u.id}
              onClick={() => setEditing(u.id)}
              className="rounded-xl border bg-card p-4 text-left"
            >
              <div className="font-medium">{u.name}</div>
              <div className="break-all text-sm text-muted-foreground">
                {u.email}
              </div>
              <div className="text-sm">
                {u.active ? '啟用' : '停用'} ·{' '}
                {
                  {
                    admin: '管理員',
                    manager: '主管',
                    user: '外收',
                    reviewer: '審核',
                    finance: '財務',
                    restricted: '受限',
                  }[u.role ?? 'user']
                }
              </div>
            </button>
          ))}
        </div>
      )}
      <Button onClick={() => setEditing('new')}>新增使用者</Button>
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!save.isPending && !open) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{row ? '編輯使用者與權限' : '新增使用者'}</DialogTitle>
            <DialogDescription>
              Email 白名單與權限使用同一份帳號資料，拒絕權限優先。
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <form
              key={editing}
              className="space-y-4 rounded-xl border bg-card p-4"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const allow: Permission[] = [],
                  deny: Permission[] = [];
                for (const key of keys.data ?? []) {
                  if (f.get(key) === 'allow') allow.push(key);
                  if (f.get(key) === 'deny') deny.push(key);
                }
                save.mutate({
                  id: row?.id,
                  name: String(f.get('name')),
                  email: String(f.get('email')).trim().toLowerCase(),
                  role: String(f.get('role')) as
                    | 'admin'
                    | 'manager'
                    | 'user'
                    | 'reviewer'
                    | 'finance'
                    | 'restricted',
                  active: f.has('active'),
                  allow,
                  deny,
                  expectedVersion: row?.version ?? 0,
                });
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Label>
                  姓名
                  <Input name="name" required defaultValue={row?.name} />
                </Label>
                <Label>
                  電子郵件
                  <Input
                    name="email"
                    type="email"
                    required
                    defaultValue={row?.email}
                  />
                </Label>
                <Label>
                  角色
                  <select
                    name="role"
                    aria-label="角色"
                    defaultValue={row?.role ?? 'user'}
                    className="h-9 w-full rounded-lg border bg-background px-3"
                  >
                    {Object.entries({
                      admin: '管理員',
                      manager: '主管',
                      user: '外收',
                      reviewer: '審核',
                      finance: '財務',
                      restricted: '受限',
                    }).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Label>
                <Label className="flex items-center gap-2">
                  <input
                    name="active"
                    type="checkbox"
                    defaultChecked={row?.active ?? true}
                  />
                  允許登入
                </Label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {keys.data?.map((key) => (
                  <Label key={key} className="space-y-1">
                    {permissionLabels[key] ?? key}
                    <span className="block text-xs text-muted-foreground">
                      目前有效：
                      {row?.effectivePermissions.includes(key)
                        ? '允許'
                        : '未授權'}
                    </span>
                    <select
                      name={key}
                      aria-label={permissionLabels[key] ?? key}
                      defaultValue={
                        JSON.parse(row?.deny ?? '[]').includes(key)
                          ? 'deny'
                          : JSON.parse(row?.allow ?? '[]').includes(key)
                            ? 'allow'
                            : 'default'
                      }
                      className="h-9 w-full rounded-lg border bg-background px-3"
                    >
                      <option value="default">角色預設</option>
                      <option value="allow">明確允許</option>
                      <option value="deny">明確拒絕</option>
                    </select>
                  </Label>
                ))}
              </div>
              <div className="flex gap-2">
                <Button disabled={save.isPending}>儲存</Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditing(null)}
                >
                  取消
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
