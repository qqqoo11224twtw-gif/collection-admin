import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@saasflare-dev/ui/components/dialog';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { displayError } from '~/components/cases/display-labels';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { orpc } from '~/lib/orpc';

const statusLabels: Record<string, string> = {
  synced: '已同步',
  drift: '與 Cloudflare 不同步',
  revoke_failed: '白名單已移除，但 Session 撤銷失敗',
  revoke_pending: '白名單已移除，Session 尚待撤銷',
};
const actionLabels = {
  add: '新增',
  enable: '啟用',
  disable: '停用',
  remove: '移除',
  sync: '重新同步',
};
const operationLabels: Record<string, string> = {
  pending: '處理中',
  success: '成功',
  partial: '部分完成',
  failed: '失敗',
  reconciled: '已核對',
};
const date = (value: number | null) =>
  value ? new Date(value).toLocaleString('zh-TW') : '—';
export function AccessEmailsPage() {
  const permission = useCasePermissions(),
    qc = useQueryClient();
  const list = useQuery({
    ...orpc.access.list.queryOptions(),
    enabled: permission.can('access.manage'),
    retry: false,
  });
  const [showHistory, setShowHistory] = useState(false);
  const [showProtection, setShowProtection] = useState(false);
  const protection = useQuery({
    ...orpc.access.protection.queryOptions(),
    enabled: permission.can('access.manage') && showProtection,
    retry: false,
  });
  const history = useQuery({
    ...orpc.access.history.queryOptions(),
    enabled: permission.can('access.manage') && showHistory,
  });
  const mutation = useMutation(orpc.access.mutate.mutationOptions());
  const sync = useMutation(orpc.access.sync.mutationOptions());
  const [email, setEmail] = useState(''),
    [message, setMessage] = useState(''),
    [failure, setFailure] = useState('');
  const [confirmation, setConfirmation] = useState<{
    email: string;
    action: 'disable' | 'remove';
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const busy = mutation.isPending || sync.isPending;
  async function run(
    target: string,
    action: 'add' | 'enable' | 'disable' | 'remove',
  ) {
    if (!list.data) return;
    setMessage('');
    setFailure('');
    try {
      const result = await mutation.mutateAsync({
        email: target,
        action,
        expectedRevision: list.data.revision,
        confirmAccountWideRevocation: confirmed,
      });
      setMessage(result.message);
      if (result.partial) setFailure(result.message);
      setConfirmation(null);
      setConfirmed(false);
      setEmail('');
    } catch (cause) {
      setFailure(
        displayError(cause, 'Access 操作未完成，請重新讀取 Cloudflare 狀態。'),
      );
    }
    await qc.invalidateQueries({ queryKey: orpc.access.key() });
  }
  async function reconcile() {
    setMessage('');
    setFailure('');
    try {
      await sync.mutateAsync({ confirmRecovery: !!list.data?.busy });
      setMessage(
        '已依 Cloudflare 實際白名單重新同步；尚待撤銷的 Session 仍需執行停用。',
      );
    } catch (cause) {
      setFailure(displayError(cause, '重新同步失敗。'));
    }
    await qc.invalidateQueries({ queryKey: orpc.access.key() });
  }
  if (permission.isPending) return <p>載入中…</p>;
  if (!permission.can('access.manage')) return <p role="alert">無操作權限</p>;
  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm text-muted-foreground">設定</p>
        <h1 className="text-2xl font-semibold">Access 授權信箱</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          管理 Cloudflare 入口白名單。信箱不需綁定系統帳號；原有帳密、TOTP 與 15
          分鐘閒置登出保持不變。
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={reconcile}>
          重新同步
        </Button>
        <Button variant="outline" onClick={() => setShowHistory(!showHistory)}>
          檢視操作紀錄
        </Button>
        <Button
          variant="outline"
          onClick={() => setShowProtection(!showProtection)}
        >
          核對 Access 設定
        </Button>
      </div>
      {showProtection && (
        <section className="space-y-2 rounded-xl border bg-card p-4 text-sm">
          <h2 className="font-medium">Cloudflare 實際入口設定</h2>
          {protection.isPending && <p>載入中…</p>}
          {protection.error && (
            <p role="alert">
              {displayError(
                protection.error,
                '無法讀取 Application／Policy／Global 設定，請核對 Token 讀取權限。',
              )}
            </p>
          )}
          {protection.data && (
            <>
              <p>保護位置：{protection.data.hostname}</p>
              <p>Application Session：{protection.data.applicationSession}</p>
              <p>Allow Policy Session：{protection.data.policySession}</p>
              <p>Global Session：{protection.data.globalSession}</p>
              <p>
                限定 Web hostname：
                {protection.data.exactHostnameOnly ? '通過' : '待確認'}
              </p>
              <p>
                唯一 Group Allow：
                {protection.data.soleAllowGroup ? '通過' : '待確認'}
              </p>
              <p>
                僅 Email One-Time PIN：
                {protection.data.otpOnly ? '通過' : '待確認'}
              </p>
              <p>
                三層 720h／無裝置 Session 覆寫：
                {protection.data.allSessions720h &&
                protection.data.noDeviceSessionOverride
                  ? '通過'
                  : '待確認'}
              </p>
            </>
          )}
        </section>
      )}
      {(list.error || failure) && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {failure ||
            displayError(
              list.error,
              '尚未設定 Access 連線，或 Cloudflare 無法讀取。',
            )}
          <Button variant="ghost" onClick={() => list.refetch()}>
            重新讀取
          </Button>
        </p>
      )}
      {message && !failure && (
        <output className="block text-sm">{message}</output>
      )}
      {list.data?.busy && (
        <p role="alert" className="text-sm text-warning">
          有尚未完成的同步作業。等兩分鐘後可重新同步核對實際結果；不會盲目重送更新。
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(email, 'add');
        }}
      >
        <div className="min-w-0 flex-1">
          <Label htmlFor="access-email">Email</Label>
          <Input
            id="access-email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="off"
            placeholder="name@example.com"
          />
        </div>
        <Button disabled={busy || !list.data || list.data.busy}>
          新增 Email
        </Button>
      </form>
      {list.isPending && <p>載入中…</p>}
      {list.data && (
        <>
          <p className="text-sm text-muted-foreground">
            Cloudflare 有效授權信箱：{list.data.activeCount} 個
          </p>
          <div className="space-y-3 md:hidden">
            {list.data.items
              .filter(
                (row) =>
                  !row.deleted_at ||
                  row.cloudActive ||
                  row.sync_status !== 'synced',
              )
              .map((row) => (
                <article
                  key={row.email}
                  className="space-y-3 rounded-xl border bg-card p-4"
                >
                  <p className="break-all font-medium">{row.email}</p>
                  <p className="text-sm">
                    {row.cloudActive ? '啟用' : '停用'} ·{' '}
                    {statusLabels[row.sync_status]}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    建立：{date(row.created_at)}
                    <br />
                    最後修改：{row.modified_by ?? 'Cloudflare 外部管理者'}
                  </p>
                  <Actions row={row} />
                </article>
              ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/30">
                <tr>
                  {[
                    'Email',
                    '狀態',
                    'Cloudflare 同步狀態',
                    '建立時間',
                    '最後修改者',
                    '操作',
                  ].map((title) => (
                    <th key={title} className="p-3">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.data.items
                  .filter(
                    (row) =>
                      !row.deleted_at ||
                      row.cloudActive ||
                      row.sync_status !== 'synced',
                  )
                  .map((row) => (
                    <tr key={row.email} className="border-t">
                      <td className="break-all p-3">{row.email}</td>
                      <td className="p-3">
                        {row.cloudActive ? '啟用' : '停用'}
                      </td>
                      <td className="p-3">{statusLabels[row.sync_status]}</td>
                      <td className="p-3">{date(row.created_at)}</td>
                      <td className="p-3">
                        {row.modified_by ?? 'Cloudflare 外部管理者'}
                      </td>
                      <td className="p-3">
                        <Actions row={row} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!list.data.items.length && (
            <p className="py-8 text-center text-muted-foreground">
              暫無授權信箱
            </p>
          )}
        </>
      )}
      {showHistory && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">操作紀錄</h2>
          {history.isPending && <p>載入中…</p>}
          {history.error && <p role="alert">操作紀錄讀取失敗</p>}
          {history.data?.map((row) => (
            <article
              key={String(row.id)}
              className="rounded-lg border p-3 text-sm"
            >
              <p className="break-all">
                {String(row.email)} ·{' '}
                {actionLabels[row.action as keyof typeof actionLabels]} ·{' '}
                {operationLabels[String(row.status)]}
              </p>
              <p className="text-muted-foreground">
                {date(Number(row.created_at))} · {String(row.operator)}
                {row.error_code ? ` · ${String(row.error_code)}` : ''}
              </p>
            </article>
          ))}
        </section>
      )}
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!busy && !open) {
            setConfirmation(null);
            setConfirmed(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.action === 'remove' ? '移除' : '停用'}授權信箱
            </DialogTitle>
            <DialogDescription className="break-all">
              {confirmation?.email} 將移出白名單。這也會撤銷該信箱在同一
              Cloudflare 帳號下所有 Access 應用的
              Session，不限本後台。網站帳號不會被停用。
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已確認上述帳號範圍影響
          </label>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setConfirmation(null);
                setConfirmed(false);
              }}
            >
              取消
            </Button>
            <Button
              disabled={!confirmed || busy}
              onClick={() =>
                confirmation && run(confirmation.email, confirmation.action)
              }
            >
              確認{confirmation?.action === 'remove' ? '移除' : '停用'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
  function Actions({
    row,
  }: {
    row: { email: string; cloudActive: boolean; sync_status: string };
  }) {
    return (
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || list.data?.busy}
          onClick={() => {
            if (
              row.cloudActive ||
              ['revoke_failed', 'revoke_pending'].includes(row.sync_status)
            ) {
              setConfirmation({ email: row.email, action: 'disable' });
              setConfirmed(false);
            } else {
              void run(row.email, 'enable');
            }
          }}
        >
          {row.cloudActive
            ? '停用'
            : ['revoke_failed', 'revoke_pending'].includes(row.sync_status)
              ? '重試撤銷'
              : '啟用'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || list.data?.busy}
          onClick={() => {
            setConfirmation({ email: row.email, action: 'remove' });
            setConfirmed(false);
          }}
        >
          移除
        </Button>
      </div>
    );
  }
}
