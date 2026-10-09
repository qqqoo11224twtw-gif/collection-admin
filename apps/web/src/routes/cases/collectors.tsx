import type { AppRouterClient } from '@saasflare-dev/api';
import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@saasflare-dev/ui/components/dialog';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { displayError } from '~/components/cases/display-labels';
import { DialogContent } from '~/components/cases/localized-dialog';
import {
  useCasePermissions,
  useRefreshCases,
} from '~/components/cases/management-hooks';
import { CaseError, LoadingCases } from '~/components/cases/presentation';
import { orpc } from '~/lib/orpc';

export const Route = createFileRoute('/cases/collectors')({
  component: CollectorsPage,
});
type Collector = Awaited<
  ReturnType<AppRouterClient['collectors']['list']>
>[number];
function CollectorEditor({ record }: { record?: Collector }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const options = orpc.collectors.users.queryOptions();
  const users = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: open,
  });
  const create = useMutation(orpc.collectors.create.mutationOptions());
  const edit = useMutation(orpc.collectors.edit.mutationOptions());
  const busy = create.isPending || edit.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={record ? 'outline' : 'default'}
          size={record ? 'sm' : 'default'}
        >
          {record ? '編輯外收人員' : '新增外收人員'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{record ? '編輯外收人員' : '新增外收人員'}</DialogTitle>
          <DialogDescription>
            綁定登入帳號後可查看指派案件。Telegram 回報身份由回報群決定。
          </DialogDescription>
        </DialogHeader>
        {open && (
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setError('');
              const data = new FormData(event.currentTarget);
              const fields = {
                displayName: String(data.get('displayName')),
                code: String(data.get('code')),
                userId: String(data.get('userId') ?? '') || null,
                isActive: record?.isActive ?? true,
              };
              try {
                if (record)
                  await edit.mutateAsync({
                    ...fields,
                    id: record.id,
                    expectedVersion: record.version,
                  });
                else await create.mutateAsync(fields);
                await refresh();
                setOpen(false);
              } catch (failure: unknown) {
                setError(displayError(failure, '無法儲存外收人員。'));
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="collector-name">顯示名稱</Label>
              <Input
                id="collector-name"
                name="displayName"
                required
                maxLength={120}
                defaultValue={record?.displayName}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="collector-code">外收人員代號</Label>
              <Input
                id="collector-code"
                name="code"
                required
                maxLength={60}
                defaultValue={record?.code}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="collector-user">登入帳號</Label>
              <select
                id="collector-user"
                name="userId"
                defaultValue={record?.userId ?? ''}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">未綁定登入帳號</option>
                {users.data?.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.email}
                  </option>
                ))}
              </select>
              <p className="text-sm text-muted-foreground">
                仍有有效派單時，無法變更登入帳號綁定。
              </p>
            </div>
            {users.isError && (
              <p role="alert" className="text-sm text-destructive">
                無法載入登入帳號。
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={busy || users.isPending || users.isError}
            >
              {busy ? '儲存中…' : '儲存外收人員'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
function CollectorsPage() {
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const [error, setError] = useState('');
  const options = orpc.collectors.list.queryOptions();
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('collector.manage'),
  });
  const toggle = useMutation(orpc.collectors.edit.mutationOptions());
  const routes = useQuery({
    ...orpc.telegram.routes.queryOptions(),
    enabled: permissions.can('telegram_route.manage'),
  });
  if (permissions.isPending) return <LoadingCases />;
  if (!permissions.can('collector.manage'))
    return (
      <p role="alert" className="text-sm text-destructive">
        無外收人員管理權限。
      </p>
    );
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">外收人員</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            管理負責委外案件的外收人員。
          </p>
        </div>
        <CollectorEditor />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result.isPending ? (
        <LoadingCases />
      ) : result.isError ? (
        <CaseError retry={() => void result.refetch()} />
      ) : !result.data.length ? (
        <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
          暫無外收人員，請新增第一位外收人員。
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {result.data.map((record) => (
            <article
              key={record.id}
              className="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
            >
              <div className="flex justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium">{record.displayName}</h2>
                  <p className="mt-2 text-sm font-mono text-muted-foreground">
                    {record.code}
                  </p>
                </div>
                <Badge variant="secondary">
                  {record.isActive ? '啟用中' : '已停用'}
                </Badge>
              </div>
              <p className="mt-4 text-sm text-muted-foreground">
                {record.userId ? '已綁定登入帳號' : '未綁定登入帳號'}
              </p>
              {permissions.can('telegram_route.manage') && (
                <div className="mt-3 space-y-1 text-sm text-muted-foreground">
                  {[
                    ['collector_dispatch', '收單群'],
                    ['collector_report', '回報群'],
                  ].map(([type, label]) => {
                    const route = routes.data?.find(
                      (r) =>
                        r.collectorId === record.id &&
                        r.isActive &&
                        (r.routeType === type ||
                          (type === 'collector_dispatch' &&
                            r.routeType === 'collector')),
                    );
                    return (
                      <p key={type}>
                        {label}：
                        {route
                          ? `${route.name || label} · ${route.chatId} / Topic ${route.topicId ?? '無'}`
                          : '尚未設定'}
                      </p>
                    );
                  })}
                  <Link
                    to="/cases/telegram"
                    className="text-foreground underline"
                  >
                    管理 Telegram 群組
                  </Link>
                </div>
              )}
              <div className="mt-4 flex gap-2">
                <CollectorEditor record={record} />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={toggle.isPending}
                  onClick={async () => {
                    setError('');
                    try {
                      await toggle.mutateAsync({
                        id: record.id,
                        expectedVersion: record.version,
                        displayName: record.displayName,
                        code: record.code,
                        userId: record.userId,
                        isActive: !record.isActive,
                      });
                      await refresh();
                    } catch (failure: unknown) {
                      setError(displayError(failure, '無法變更外收人員狀態。'));
                    }
                  }}
                >
                  {record.isActive ? '停用' : '啟用'}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
