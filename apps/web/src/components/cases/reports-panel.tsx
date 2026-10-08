import type { AppRouterClient } from '@saasflare-dev/api';
import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogContent,
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
import { orpc } from '~/lib/orpc';
import { useCasePermissions, useRefreshCases } from './management-hooks';
import { CaseError, LoadingCases, money, timestamp } from './presentation';

type Report = Awaited<ReturnType<AppRouterClient['reports']['list']>>[number];
const statuses = {
  cannot_find: 'Cannot find',
  follow_up: 'Follow-up',
  installment: 'Installment',
  settled: 'Settled',
  unresolved: 'Unresolved',
  needs_review: 'Needs review',
};
export const reportRevisitLabels = {
  recommended: 'Recommended',
  observe: 'Observe',
  not_recommended: 'Not recommended',
  not_needed: 'Not needed',
};
const sources = {
  admin: 'Admin',
  collector_portal: 'Collector portal',
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
          {record ? 'Edit report' : 'New report'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{record ? 'Edit report' : 'Create report'}</DialogTitle>
          <DialogDescription>
            Record your visit and findings. Payment markers do not create
            financial entries.
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
                setError(
                  failure instanceof Error
                    ? failure.message
                    : 'Unable to save report.',
                );
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="report-content">Report content</Label>
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
                <Label htmlFor="report-status">Report status</Label>
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
                <Label htmlFor="report-revisit">Revisit recommendation</Label>
                <select
                  id="report-revisit"
                  name="revisitStatus"
                  defaultValue={record?.revisitStatus ?? ''}
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="">Keep current recommendation</option>
                  {Object.entries(reportRevisitLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-reason">Revisit reason</Label>
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
              Payment detected
            </Label>
            <div className="space-y-2">
              <Label htmlFor="report-payment">
                Reported payment amount (TWD)
              </Label>
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
                Cancel
              </Button>
              <Button disabled={busy}>
                {busy ? 'Saving…' : record ? 'Save report' : 'Create report'}
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
      <p className="text-sm text-muted-foreground">
        You do not have access to reports.
      </p>
    );
  if (result.isPending) return <LoadingCases />;
  if (result.isError) return <CaseError retry={() => void result.refetch()} />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Visit findings and recommendations, newest first.
        </p>
        {permissions.can('report.create') && (
          <ReportEditor caseId={caseId} version={version} />
        )}
      </div>
      {!result.data.length && (
        <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
          No reports yet.
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
                    ? 'Awaiting collector selection'
                    : statuses[record.status]}
                </Badge>
                {permissions.can('report.edit') &&
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
                Collector selected: {statuses[record.selectedStatus]} ·
                Completed by {record.completedBy ?? record.author}
                {record.completedAt && ` · ${timestamp(record.completedAt)}`}
              </p>
            )}
            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">
                  Revisit recommendation
                </dt>
                <dd className="mt-1 text-sm font-medium">
                  {record.revisitStatus
                    ? reportRevisitLabels[record.revisitStatus]
                    : 'No recommendation recorded'}
                </dd>
                {record.revisitReason && (
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                    {record.revisitReason}
                  </p>
                )}
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  Payment observation
                </dt>
                <dd className="mt-1 text-sm">
                  {record.paymentDetected
                    ? 'Payment detected'
                    : 'No payment detected'}
                  {record.paymentAmount !== null &&
                    ` · ${money(record.paymentAmount)}`}
                </dd>
              </div>
            </dl>
            {record.version > 0 && (
              <p className="mt-4 text-sm text-muted-foreground">
                Edited {timestamp(record.updatedAt)}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
