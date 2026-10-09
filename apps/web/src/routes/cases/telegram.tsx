import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { orpc } from '~/lib/orpc';
export const Route = createFileRoute('/cases/telegram')({
  component: TelegramPage,
});
const types = {
  intake: '小幫手收件',
  collector_dispatch: '外收收單群',
  collector_report: '外收回報群',
  business_report: '業務回報群',
} as const;
function canonical(type: string) {
  return (
    (
      {
        collector: 'collector_dispatch',
        intake_source: 'intake',
        report_destination: 'business_report',
      } as Record<string, string>
    )[type] ?? type
  );
}
function TelegramPage() {
  const permissions = useCasePermissions(),
    qc = useQueryClient();
  const enabled = permissions.can('telegram_route.manage');
  const routes = useQuery({ ...orpc.telegram.routes.queryOptions(), enabled }),
    options = useQuery({ ...orpc.telegram.options.queryOptions(), enabled });
  const [editing, setEditing] = useState<string | null>(null),
    [group, setGroup] = useState<keyof typeof types>('intake'),
    [message, setMessage] = useState('');
  const save = useMutation(
    orpc.telegram.saveRoute.mutationOptions({
      onSuccess: () => {
        setEditing(null);
        setMessage('儲存成功，下一個請求立即生效。');
        void qc.invalidateQueries();
      },
      onError: (e) => setMessage(e.message),
    }),
  );
  const test = useMutation(
    orpc.telegram.testRoute.mutationOptions({
      onSuccess: (r) => setMessage(r.message),
      onError: () => setMessage('測試失敗，請查看系統管理日誌。'),
    }),
  );
  if (permissions.isPending) return <p>載入中…</p>;
  if (!enabled) return <p>無操作權限</p>;
  const row = routes.data?.find((r) => r.id === editing);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Telegram 群組設定</h1>
      <p className="text-sm text-muted-foreground">
        回報群直接代表外收人員，不需設定 Telegram 使用者身分。Bot
        憑證由伺服器管理。
      </p>
      <div className="flex flex-wrap gap-2">
        {Object.entries(types).map(([key, label]) => (
          <Button
            key={key}
            variant={group === key ? 'default' : 'outline'}
            onClick={() => {
              setGroup(key as keyof typeof types);
              setEditing(null);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {message && <output className="text-sm">{message}</output>}
      {routes.isPending ? (
        <p>載入中…</p>
      ) : routes.isError ? (
        <p>載入失敗</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {routes.data
            ?.filter((r) => canonical(r.routeType) === group)
            .map((r) => (
              <div
                key={r.id}
                className="space-y-3 rounded-xl border bg-card p-4"
              >
                <div className="font-medium">{r.name || types[group]}</div>
                <div className="space-y-1 break-all text-sm text-muted-foreground">
                  <p>
                    群組 ID：{r.chatId} · Topic：{r.topicId ?? '無'}
                  </p>
                  <p>
                    外收人員：
                    {options.data?.collectors.find(
                      (c) => c.id === r.collectorId,
                    )?.displayName ?? '未綁定'}
                  </p>
                  <p>{r.isActive ? '啟用' : '停用'}</p>
                  <p>建立：{new Date(r.createdAt).toLocaleString('zh-TW')}</p>
                  <p>更新：{new Date(r.updatedAt).toLocaleString('zh-TW')}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setEditing(r.id)}>
                    編輯
                  </Button>
                  <Button
                    variant="outline"
                    disabled={save.isPending}
                    onClick={() =>
                      save.mutate({
                        id: r.id,
                        name: r.name,
                        chatId: r.chatId,
                        topicId: r.topicId,
                        collectorId: r.collectorId,
                        routeType: canonical(r.routeType) as keyof typeof types,
                        isActive: !r.isActive,
                      })
                    }
                  >
                    {r.isActive ? '停用' : '啟用'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!r.isActive || test.isPending}
                    onClick={() => test.mutate({ id: r.id })}
                  >
                    測試發送
                  </Button>
                </div>
              </div>
            ))}
        </div>
      )}
      <Button onClick={() => setEditing('new')}>新增路由</Button>
      {editing && (
        <form
          key={editing}
          className="space-y-4 rounded-xl border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            save.mutate({
              id: row?.id,
              name: String(f.get('name')),
              chatId: String(f.get('chatId')),
              topicId: f.get('topicId') ? Number(f.get('topicId')) : null,
              collectorId: String(f.get('collectorId') || '') || null,
              routeType: group,
              isActive: f.has('active'),
            });
          }}
        >
          <h2 className="text-lg font-medium">{types[group]}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Label>
              名稱
              <Input name="name" required defaultValue={row?.name} />
            </Label>
            <Label>
              群組 ID
              <Input name="chatId" required defaultValue={row?.chatId} />
            </Label>
            <Label>
              Topic ID（選填）
              <Input
                name="topicId"
                type="number"
                min={1}
                defaultValue={row?.topicId ?? ''}
              />
            </Label>
            <Label>
              綁定外收人員
              <select
                name="collectorId"
                aria-label="綁定外收人員"
                required={group.startsWith('collector_')}
                defaultValue={row?.collectorId ?? ''}
                className="h-9 w-full rounded-lg border bg-background px-3"
              >
                <option value="">未綁定</option>
                {options.data?.collectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="flex items-center gap-2">
              <input
                name="active"
                type="checkbox"
                defaultChecked={row?.isActive ?? true}
              />
              啟用
            </Label>
          </div>
          <div className="flex gap-2">
            <Button disabled={save.isPending}>儲存路由</Button>
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
    </div>
  );
}
