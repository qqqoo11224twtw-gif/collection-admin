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
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { displayError, displayLabel } from '~/components/cases/display-labels';
import { DialogContent } from '~/components/cases/localized-dialog';
import { orpc } from '~/lib/orpc';
import { useCasePermissions, useRefreshCases } from './management-hooks';

type Result = Awaited<ReturnType<AppRouterClient['cases']['bulkAssign']>>;
const reasons: Record<string, string> = {
  ALREADY_ASSIGNED: '已由其他管理員派單',
  CASE_UNAVAILABLE: '案件不存在或無操作權限',
  ROUTE_UNAVAILABLE: 'Telegram 路由無法使用',
  RECORD_CHANGED: '案件或路由已變更，請重新整理後重試',
  SAVE_FAILED: '無法儲存此案件',
  INVALID_CASE_DATA: '案件資料超過 Telegram 訊息長度限制',
};
export function BulkAssignmentDialog({
  caseIds,
  onAssigned,
}: {
  caseIds: string[];
  onAssigned: () => void;
}) {
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const [open, setOpen] = useState(false);
  const [collectorId, setCollectorId] = useState('');
  const [request, setRequest] = useState<{
    batchId: string;
    caseIds: string[];
  } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const mutation = useMutation(orpc.cases.bulkAssign.mutationOptions());
  const options = orpc.cases.bulkAssignmentCollectors.queryOptions();
  const collectors = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: open && !result,
  });
  const resultOptions = orpc.cases.bulkAssignmentResult.queryOptions({
    input: { batchId: result?.batchId ?? '' },
  });
  const live = useQuery({
    ...resultOptions,
    queryKey: [permissions.userId, ...resultOptions.queryKey],
    enabled: open && !!result,
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (item) =>
          item.status === 'pending' ||
          item.telegramStatus === 'pending' ||
          item.telegramStatus === 'sending',
      )
        ? 2000
        : false,
  });
  const outcome = live.data ?? result;
  const chosen = collectors.data?.find((item) => item.id === collectorId);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (mutation.isPending) return;
        setOpen(value);
        if (value) {
          setResult(null);
          setCollectorId('');
          setError('');
          setRequest({ batchId: crypto.randomUUID(), caseIds: [...caseIds] });
        }
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={!caseIds.length}>批量委外</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{outcome ? '批量委外完成' : '批量委外'}</DialogTitle>
          <DialogDescription>
            {outcome
              ? '各案件已分別儲存派單紀錄，Telegram 訊息將由傳送佇列繼續處理。'
              : '每筆案件會各自建立派單及 Telegram 訊息，並使用外收人員有效的群組與話題。'}
          </DialogDescription>
        </DialogHeader>
        {outcome ? (
          <div className="space-y-4">
            <div
              aria-live="polite"
              className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3"
            >
              <p>成功： {outcome.summary.assigned}</p>
              <p>略過： {outcome.summary.skipped}</p>
              <p>儲存失敗： {outcome.summary.failed}</p>
              <p>Telegram 待傳送： {outcome.summary.telegramQueued}</p>
              <p>Telegram 待重試： {outcome.summary.telegramRetrying}</p>
              <p>Telegram 傳送失敗： {outcome.summary.telegramFailed}</p>
              {!!outcome.summary.telegramBlocked && (
                <p className="text-warning">
                  Telegram 機器人已停用： {outcome.summary.telegramBlocked}
                </p>
              )}
              <p>Telegram 已傳送： {outcome.summary.telegramSent}</p>
              {!!outcome.summary.processing && (
                <p>處理中： {outcome.summary.processing}</p>
              )}
            </div>
            <p className="break-all text-sm text-muted-foreground">
              批次編號： {outcome.batchId}
            </p>
            {live.isError && (
              <p role="alert" className="text-sm text-destructive">
                無法更新傳送狀態。
                <Button variant="link" onClick={() => void live.refetch()}>
                  重新取得狀態
                </Button>
              </p>
            )}
            <ul className="space-y-3" aria-label="各案件派單結果">
              {outcome.items.map((item) => (
                <li key={item.caseId} className="rounded-lg border p-3 text-sm">
                  <p className="break-words font-medium">
                    {item.label
                      ? `${item.label.caseNo} · ${item.label.customerName}`
                      : '無法查看的案件'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge
                      variant={
                        item.status === 'assigned' ? 'secondary' : 'outline'
                      }
                    >
                      {displayLabel(item.status)}
                    </Badge>
                    {item.telegramStatus && (
                      <Badge variant="outline">
                        Telegram： {displayLabel(item.telegramStatus)}
                      </Badge>
                    )}
                  </div>
                  {item.reason && (
                    <p className="mt-2 text-muted-foreground">
                      {reasons[item.reason] ?? '無法處理此案件'}
                    </p>
                  )}
                  {item.telegramError && (
                    <p className="mt-2 break-words text-muted-foreground">
                      {item.telegramError === 'DELIVERY_UNKNOWN'
                        ? '傳送結果不明，重新寄送前需人工確認。'
                        : `Delivery: ${item.telegramError}`}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <Button onClick={() => setOpen(false)}>完成</Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!request) return;
              setError('');
              try {
                const output = await mutation.mutateAsync({
                  ...request,
                  collectorId,
                });
                setResult(output);
                onAssigned();
                await refresh();
              } catch (failure: unknown) {
                setError(
                  displayError(
                    failure,
                    '無法儲存批量委外，重試時會使用相同批次編號。',
                  ),
                );
              }
            }}
          >
            <p className="text-sm">
              已選擇： {request?.caseIds.length ?? caseIds.length} 筆案件
            </p>
            <div className="space-y-2">
              <Label htmlFor="bulk-collector">外收人員</Label>
              <select
                id="bulk-collector"
                required
                value={collectorId}
                disabled={mutation.isPending}
                onChange={(event) => setCollectorId(event.target.value)}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">請選擇外收人員</option>
                {collectors.data?.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={item.routeCount !== 1}
                  >
                    {item.displayName} · {item.code}
                    {item.routeCount !== 1 ? ' — 需要有效路由' : ''}
                  </option>
                ))}
              </select>
            </div>
            {chosen && (
              <p className="text-sm">外收人員： {chosen.displayName}</p>
            )}
            {collectors.isPending && (
              <output className="text-sm text-muted-foreground">
                載入外收人員中…
              </output>
            )}
            {collectors.isError && (
              <p role="alert" className="text-sm text-destructive">
                無法載入外收人員。
                <Button
                  type="button"
                  variant="link"
                  onClick={() => void collectors.refetch()}
                >
                  重試
                </Button>
              </p>
            )}
            {collectors.data &&
              !collectors.data.some((item) => item.routeCount === 1) && (
                <p className="text-sm text-muted-foreground">
                  派單前請先設定一組有效的 Telegram 外收人員路由。
                </p>
              )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={mutation.isPending || chosen?.routeCount !== 1}
              >
                {mutation.isPending ? '派單中…' : '確認派單'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
