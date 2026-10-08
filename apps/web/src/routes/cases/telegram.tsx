import type { AppRouterClient } from '@saasflare-dev/api';
import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { displayError, displayLabel } from '~/components/cases/display-labels';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { CaseError, LoadingCases } from '~/components/cases/presentation';
import { orpc } from '~/lib/orpc';
export const Route = createFileRoute('/cases/telegram')({
  component: TelegramSettings,
});
type RouteRecord = Awaited<
  ReturnType<AppRouterClient['telegram']['routes']>
>[number];
type Identity = Awaited<
  ReturnType<AppRouterClient['telegram']['identities']>
>[number];
function TelegramSettings() {
  const permissions = useCasePermissions();
  const allowed = permissions.can('telegram_route.manage');
  const cache = useQueryClient();
  const scoped = <T,>(options: T & { queryKey: readonly unknown[] }) => ({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: allowed,
  });
  const routes = useQuery(scoped(orpc.telegram.routes.queryOptions()));
  const identities = useQuery(scoped(orpc.telegram.identities.queryOptions()));
  const options = useQuery(scoped(orpc.telegram.options.queryOptions()));
  const jobs = useQuery(scoped(orpc.telegram.jobs.queryOptions()));
  const saveRoute = useMutation(orpc.telegram.saveRoute.mutationOptions());
  const saveIdentity = useMutation(
    orpc.telegram.saveIdentity.mutationOptions(),
  );
  const process = useMutation(orpc.telegram.process.mutationOptions());
  const [editingRoute, setEditingRoute] = useState<RouteRecord | null>(null);
  const [editingIdentity, setEditingIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState('');
  const refresh = () =>
    cache.invalidateQueries({
      predicate: (query) => query.queryKey[0] === permissions.userId,
    });
  const fail = (e: unknown) => setError(displayError(e, '無法儲存設定。'));
  const busy =
    saveRoute.isPending || saveIdentity.isPending || process.isPending;
  if (permissions.isPending) return <LoadingCases />;
  if (!allowed)
    return (
      <div className="rounded-xl border p-5">
        <h1 className="font-semibold">無操作權限</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          需要 Telegram 管理權限。
        </p>
      </div>
    );
  if (routes.isPending || identities.isPending || options.isPending)
    return <LoadingCases />;
  if (routes.isError || identities.isError || options.isError)
    return (
      <CaseError
        retry={() => {
          void refresh();
        }}
      />
    );
  return (
    <div className="space-y-6">
      {/* Administrative integration context. */}
      <div>
        <h1 className="text-xl font-semibold">Telegram 設定</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          管理授權路由與外收人員身分。模式： {displayLabel(options.data.mode)}
          。憑證只保存在伺服器。
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Route and identity editors. */}
        <section className="space-y-4 rounded-xl border bg-card p-5">
          <h2 className="font-semibold">
            {editingRoute ? '編輯路由' : '新增路由'}
          </h2>
          <form
            key={editingRoute?.id ?? 'new-route'}
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              const f = new FormData(e.currentTarget);
              try {
                await saveRoute.mutateAsync({
                  id: editingRoute?.id,
                  chatId: String(f.get('chatId')),
                  topicId: f.get('topicId') ? Number(f.get('topicId')) : null,
                  routeType: String(
                    f.get('routeType'),
                  ) as RouteRecord['routeType'],
                  collectorId: String(f.get('collectorId')) || null,
                  isActive: f.get('active') === 'on',
                });
                setEditingRoute(null);
                await refresh();
              } catch (e: unknown) {
                fail(e);
              }
            }}
          >
            <Field
              label="Telegram 群組 ID"
              name="chatId"
              required
              defaultValue={editingRoute?.chatId}
            />
            <Field
              label="Telegram 話題 ID（選填）"
              name="topicId"
              type="number"
              defaultValue={editingRoute?.topicId ?? ''}
            />
            <Label className="block space-y-2">
              路由用途
              <select
                name="routeType"
                defaultValue={editingRoute?.routeType ?? 'intake_source'}
                className="h-9 w-full rounded-lg border bg-background px-3"
              >
                <option value="intake_source">收件來源</option>
                <option value="collector">外收人員</option>
                <option value="report_destination">業務回報</option>
              </select>
            </Label>
            <Label className="block space-y-2">
              外收人員
              <select
                name="collectorId"
                defaultValue={editingRoute?.collectorId ?? ''}
                className="h-9 w-full rounded-lg border bg-background px-3"
              >
                <option value="">未指定外收人員</option>
                {options.data.collectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="active"
                defaultChecked={editingRoute?.isActive ?? true}
              />
              路由啟用中
            </Label>
            <div className="flex gap-2">
              <Button disabled={busy}>儲存路由</Button>
              {editingRoute && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingRoute(null)}
                >
                  取消
                </Button>
              )}
            </div>
          </form>
        </section>
        <section className="space-y-4 rounded-xl border bg-card p-5">
          <h2 className="font-semibold">
            {editingIdentity ? '編輯身分' : '綁定身分'}
          </h2>
          <form
            key={editingIdentity?.id ?? 'new-identity'}
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              const f = new FormData(e.currentTarget);
              try {
                await saveIdentity.mutateAsync({
                  id: editingIdentity?.id,
                  telegramUserId: String(f.get('telegramUserId')),
                  displayName: String(f.get('displayName')) || null,
                  collectorId: String(f.get('collectorId')) || null,
                  userId: String(f.get('userId')) || null,
                  isActive: f.get('active') === 'on',
                });
                setEditingIdentity(null);
                await refresh();
              } catch (e: unknown) {
                fail(e);
              }
            }}
          >
            <Field
              label="Telegram 使用者 ID"
              name="telegramUserId"
              required
              defaultValue={editingIdentity?.telegramUserId}
            />
            <Field
              label="顯示名稱（選填）"
              name="displayName"
              defaultValue={editingIdentity?.displayName ?? ''}
            />
            <Label className="block space-y-2">
              綁定外收人員
              <select
                name="collectorId"
                defaultValue={editingIdentity?.collectorId ?? ''}
                className="h-9 w-full rounded-lg border bg-background px-3"
              >
                <option value="">未綁定</option>
                {options.data.collectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="block space-y-2">
              登入帳號（選填）
              <select
                name="userId"
                defaultValue={editingIdentity?.userId ?? ''}
                className="h-9 w-full rounded-lg border bg-background px-3"
              >
                <option value="">使用外收人員登入帳號</option>
                {options.data.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.email}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="active"
                defaultChecked={editingIdentity?.isActive ?? true}
              />
              身分啟用中
            </Label>
            <div className="flex gap-2">
              <Button disabled={busy}>儲存身分</Button>
              {editingIdentity && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingIdentity(null)}
                >
                  取消
                </Button>
              )}
            </div>
          </form>
        </section>
      </div>
      <section className="space-y-3">
        <h2 className="font-semibold">路由設定</h2>
        {!routes.data.length && (
          <p className="text-sm text-muted-foreground">尚未設定路由。</p>
        )}
        {routes.data.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          >
            <div className="min-w-0 break-all text-sm">
              {displayLabel(r.routeType)} · {r.chatId}
              {r.topicId ? ` / Topic ${r.topicId}` : ''}{' '}
              <Badge variant="secondary">
                {r.isActive ? '啟用中' : '已停用'}
              </Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingRoute(r)}
            >
              編輯路由
            </Button>
          </div>
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">身分綁定</h2>
        {!identities.data.length && (
          <p className="text-sm text-muted-foreground">尚未綁定身分。</p>
        )}
        {identities.data.map((i) => (
          <div
            key={i.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          >
            <div className="text-sm">
              {i.displayName ?? '外收人員'} · {i.telegramUserId}{' '}
              <Badge variant="secondary">
                {i.isActive ? '啟用中' : '已停用'}
              </Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingIdentity(i)}
            >
              編輯身分
            </Button>
          </div>
        ))}
      </section>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">傳送工作</h2>
          {options.data.mode === 'fake' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                try {
                  await process.mutateAsync({});
                  await refresh();
                } catch (e: unknown) {
                  fail(e);
                }
              }}
            >
              處理本機工作
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          傳送結果不明時需人工核對，系統不會自動重送。
        </p>
        {jobs.isError ? (
          <p role="alert">無法載入工作。</p>
        ) : (
          jobs.data?.map((j) => (
            <div
              key={j.id}
              className="flex flex-wrap gap-3 rounded-xl border p-4 text-sm"
            >
              <span>{displayLabel(j.messageType)}</span>
              <Badge variant="secondary">{displayLabel(j.status)}</Badge>
              <span>{j.attempts} 次嘗試</span>
              {j.lastErrorCode && <span>{j.lastErrorCode}</span>}
            </div>
          ))
        )}
        {jobs.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">暫無傳送工作。</p>
        )}
      </section>
    </div>
  );
}
function Field(props: {
  label: string;
  name: string;
  required?: boolean;
  type?: string;
  defaultValue?: string | number;
}) {
  return (
    <Label className="block space-y-2">
      {props.label}
      <Input
        name={props.name}
        required={props.required}
        type={props.type ?? 'text'}
        defaultValue={props.defaultValue}
      />
    </Label>
  );
}
