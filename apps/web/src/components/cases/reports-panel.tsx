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
import { Textarea } from '@saasflare-dev/ui/components/textarea';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { displayError } from '~/components/cases/display-labels';
import { DialogContent } from '~/components/cases/localized-dialog';
import { orpc } from '~/lib/orpc';
import { useCasePermissions, useRefreshCases } from './management-hooks';
import { CaseError, LoadingCases, money, timestamp } from './presentation';

type Report = Awaited<ReturnType<AppRouterClient['reports']['list']>>[number];
const statuses = {
  cannot_find: '找不到客戶',
  follow_up: '安排二訪',
  installment: '分期',
  settled: '結清',
  unresolved: '無解',
  needs_review: '待確認',
};
export const reportRevisitLabels = {
  recommended: '值得二訪',
  observe: '可再觀察',
  not_recommended: '不建議二訪',
  not_needed: '不需二訪',
};
const sources = {
  admin: '管理員',
  collector_portal: '外收人員入口',
  telegram: 'Telegram',
  api: 'API',
};
function ReportEditor({
  caseId,
  version,
  record,
}: {
  caseId: string;
  version: number;
  record?: Report;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const create = useMutation(orpc.reports.create.mutationOptions());
  const edit = useMutation(orpc.reports.edit.mutationOptions());
  const refresh = useRefreshCases();
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
        <Button variant={record ? 'outline' : 'default'}>
          {record ? '編輯回報' : '新增回報'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{record ? '編輯回報' : '新增回報'}</DialogTitle>
          <DialogDescription>
            記錄訪查結果與建議，收款標記不會建立正式財務紀錄。
          </DialogDescription>
        </DialogHeader>
        {/* Manual classification is validated by the shared backend workflow. */}
        {open && (
          <form
            className="space-y-5"
            onSubmit={async (event) => {
              event.preventDefault();
              setError('');
              const data = new FormData(event.currentTarget);
              const text = (name: string) => String(data.get(name) ?? '');
              const paymentDetected = data.get('paymentDetected') === 'on';
              const fields = {
                caseId,
                expectedCaseVersion: version,
                content: text('content'),
                status: text('status') as Report['status'],
                revisitStatus: (text('revisitStatus') ||
                  null) as Report['revisitStatus'],
                revisitReason: text('revisitReason') || null,
                paymentDetected,
                paymentAmount:
                  paymentDetected && text('paymentAmount') !== ''
                    ? Number(text('paymentAmount'))
                    : null,
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
                setError(displayError(failure, '無法儲存回報。'));
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="report-content">回報內容</Label>
              <Textarea
                id="report-content"
                name="content"
                required
                maxLength={10000}
                defaultValue={record?.content}
                className="min-h-32"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="report-status">回報狀態</Label>
                <select
                  id="report-status"
                  name="status"
                  defaultValue={record?.status ?? 'needs_review'}
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  {Object.entries(statuses).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="report-revisit">二訪建議</Label>
                <select
                  id="report-revisit"
                  name="revisitStatus"
                  defaultValue={record?.revisitStatus ?? ''}
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="">保留目前二訪建議</option>
                  {Object.entries(reportRevisitLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-reason">二訪原因</Label>
              <Textarea
                id="report-reason"
                name="revisitReason"
                maxLength={2000}
                defaultValue={record?.revisitReason ?? ''}
              />
            </div>
            <Label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="paymentDetected"
                defaultChecked={record?.paymentDetected}
              />
              有收款標記
            </Label>
            <div className="space-y-2">
              <Label htmlFor="report-payment">回報收款金額（新臺幣）</Label>
              <Input
                id="report-payment"
                name="paymentAmount"
                type="number"
                min={0}
                max={1000000000000}
                step={1}
                defaultValue={record?.paymentAmount ?? ''}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button disabled={busy}>
                {busy ? '儲存中…' : record ? '儲存回報' : '新增回報'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
export function ReportsPanel({
  caseId,
  version,
}: {
  caseId: string;
  version: number;
}) {
  const permissions = useCasePermissions();
  const options = orpc.reports.list.queryOptions({ input: { id: caseId } });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('report.view'),
  });
  if (permissions.isPending) return <LoadingCases />;
  if (!permissions.can('report.view'))
    return (
      <p className="text-sm text-muted-foreground">無回報紀錄查看權限。</p>
    );
  if (result.isPending) return <LoadingCases />;
  if (result.isError) return <CaseError retry={() => void result.refetch()} />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          訪查結果與建議，依最新回報排序。
        </p>
        {permissions.can('report.create') && (
          <ReportEditor caseId={caseId} version={version} />
        )}
      </div>
      {!result.data.length && (
        <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
          暫無回報紀錄。
        </p>
      )}
      {/* Each report preserves its own visit recommendation and payment observation. */}
      <ol className="space-y-4">
        {result.data.map((record) => (
          <li
            key={record.id}
            className="rounded-xl bg-card p-6 ring-1 ring-foreground/10"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{record.author}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {timestamp(record.createdAt)} · {sources[record.source]}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="secondary">
                  {record.workflowStatus === 'awaiting_status'
                    ? '等待外收人員確認'
                    : record.financeEvent === 'payment'
                      ? '實際收款'
                      : record.financeEvent === 'offset'
                        ? '後結'
                        : statuses[record.status]}
                </Badge>
                {permissions.can('report.edit') &&
                  !record.financeEvent &&
                  record.workflowStatus === 'completed' && (
                    <ReportEditor
                      caseId={caseId}
                      version={version}
                      record={record}
                    />
                  )}
              </div>
            </div>
            <p className="mt-5 whitespace-pre-wrap break-words text-sm">
              {record.content}
            </p>
            {record.selectedStatus && (
              <p className="mt-4 text-sm text-muted-foreground">
                外收人員已選擇：{' '}
                {record.selectedStatus === 'direct_to_principal'
                  ? '後結'
                  : statuses[record.selectedStatus]}{' '}
                · 確認人 {record.completedBy ?? record.author}
                {record.completedAt && ` · ${timestamp(record.completedAt)}`}
              </p>
            )}
            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">二訪建議</dt>
                <dd className="mt-1 text-sm font-medium">
                  {record.revisitStatus
                    ? reportRevisitLabels[record.revisitStatus]
                    : '未提供二訪建議'}
                </dd>
                {record.revisitReason && (
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                    {record.revisitReason}
                  </p>
                )}
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">收款標記</dt>
                <dd className="mt-1 text-sm">
                  {record.paymentDetected ? '有收款標記' : '無收款標記'}
                  {record.paymentAmount !== null &&
                    ` · ${money(record.paymentAmount)}`}
                </dd>
              </div>
            </dl>
            {record.version > 0 && (
              <p className="mt-4 text-sm text-muted-foreground">
                已編輯 {timestamp(record.updatedAt)}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
