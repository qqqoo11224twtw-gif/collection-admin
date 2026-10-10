import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { orpc } from '~/lib/orpc';
import { displayError } from './display-labels';
import { useCasePermissions, useRefreshCases } from './management-hooks';

export function CollectorRateSettings() {
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const kind = 'return' as const;
  const options = orpc.collectorFinance.settings.queryOptions({
    input: { kind },
  });
  const settings = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
  });
  const collectors = useQuery(orpc.collectorFinance.collectors.queryOptions());
  const save = useMutation(orpc.collectorFinance.setRate.mutationOptions());
  const remove = useMutation(
    orpc.collectorFinance.deleteRate.mutationOptions(),
  );
  const [collectorId, setCollector] = useState('');
  const [rate, setRate] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<{
    collectorId: string;
    name: string;
    kind: 'return';
  } | null>(null);
  const act = async (operation: () => Promise<unknown>) => {
    setError('');
    setNotice('');
    try {
      await operation();
      await settings.refetch();
      await refresh();
      setNotice('設定已儲存，歷史財務紀錄不受影響。');
    } catch (failure) {
      setError(displayError(failure, '設定儲存失敗，請重新載入後再試。'));
    }
  };
  const busy = save.isPending || remove.isPending;
  return (
    <section
      aria-label="財務設定"
      className="space-y-4 rounded-xl border bg-card p-5"
    >
      <h3 className="font-medium">財務設定</h3>
      <h4>回帳比例設定</h4>
      <p className="text-sm text-muted-foreground">
        每位外收獨立設定。新增付款前必須具備有效回帳比例；修改及刪除不回算歷史交易。
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <output>{notice}</output>}
      {settings.isError && <p role="alert">財務設定載入失敗。</p>}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void act(() =>
            save.mutateAsync({
              collectorId,
              kind,
              rate: Number(rate) / 100,
              expectedVersion: settings.data?.version ?? 0,
            }),
          );
        }}
      >
        <div className="min-w-0 space-y-2">
          <Label htmlFor="rate-collector">外收人員</Label>
          <select
            id="rate-collector"
            className="h-9 max-w-full rounded-md border bg-background px-3"
            required
            value={collectorId}
            onChange={(event) => {
              const id = event.target.value;
              setCollector(id);
              const item = settings.data?.items.find(
                (row) => row.collector_id === id && row.kind === kind,
              );
              setRate(item ? String(item.rate * 100) : '');
            }}
          >
            <option value="">選擇外收人員</option>
            {collectors.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="collector-rate">回帳比例（%）</Label>
          <Input
            id="collector-rate"
            type="number"
            required
            min="0"
            max="100"
            step="0.01"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
        </div>
        <Button disabled={busy || !collectorId || !settings.data}>
          儲存變更
        </Button>
      </form>
      <div className="space-y-2">
        {settings.data?.items
          .filter((row) => row.kind === kind)
          .map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <p>
                  {row.display_name} · {(row.rate * 100).toFixed(2)}%
                </p>
                <p className="text-sm text-muted-foreground">
                  更新時間：{new Date(row.updated_at).toLocaleString('zh-TW')}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setCollector(row.collector_id);
                    setRate(String(row.rate * 100));
                  }}
                >
                  修改
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setDeleting({
                      collectorId: row.collector_id,
                      name: row.display_name,
                      kind,
                    })
                  }
                >
                  刪除
                </Button>
              </div>
            </div>
          ))}
      </div>
      {settings.data &&
        !settings.data.items.some((row) => row.kind === kind) && (
          <p className="text-muted-foreground">尚未設定此外收比例。</p>
        )}
      {deleting && (
        <div
          role="alertdialog"
          aria-label="確認刪除設定"
          className="space-y-3 rounded-lg border p-4"
        >
          <p>
            確定刪除{deleting.name}目前的 回帳 設定嗎？歷史財務紀錄不受影響。
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await remove.mutateAsync({
                  collectorId: deleting.collectorId,
                  kind: deleting.kind,
                  expectedVersion: settings.data?.version ?? 0,
                });
                setDeleting(null);
              })
            }
          >
            確認刪除
          </Button>
        </div>
      )}
    </section>
  );
}
