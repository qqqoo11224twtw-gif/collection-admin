import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useCasePermissions,
  useRefreshCases,
} from '~/components/cases/management-hooks';
import {
  CaseError,
  LoadingCases,
  money,
} from '~/components/cases/presentation';
import { orpc } from '~/lib/orpc';

export const Route = createFileRoute('/cases/finance')({
  component: FinancePage,
});
function FinancePage() {
  const permissions = useCasePermissions(),
    refresh = useRefreshCases(),
    [dateFrom, setFrom] = useState(''),
    [dateTo, setTo] = useState(''),
    [page, setPage] = useState(1),
    [error, setError] = useState(''),
    [exporting, setExporting] = useState(false);
  const options = orpc.finance.settlements.queryOptions({
      input: {
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        page,
        pageSize: 25,
      },
    }),
    result = useQuery({
      ...options,
      queryKey: [permissions.userId, ...options.queryKey],
      enabled: permissions.can('settlement.view'),
      retry: false,
    });
  const mark = useMutation(orpc.finance.markSettlement.mutationOptions());
  if (permissions.isPending) return <LoadingCases />;
  if (!permissions.can('settlement.view'))
    return <p className="text-sm text-muted-foreground">Access denied</p>;
  async function download() {
    setExporting(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      const response = await fetch(
        `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/finance/settlements.xlsx?${params}`,
        { credentials: 'include' },
      );
      if (!response.ok)
        throw new Error('Export failed. Check the dates and permissions.');
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement('a');
      link.href = url;
      link.download = `settlements-${dateFrom || 'all'}-${dateTo || 'all'}.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Finance</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Confirmed receipts and money still to be returned are tracked
          separately.
        </p>
      </div>
      {/* One date range consistently filters both ledgers and the Excel download. */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="finance-from">Date from</Label>
          <Input
            id="finance-from"
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="finance-to">Date to</Label>
          <Input
            id="finance-to"
            type="date"
            value={dateTo}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {permissions.can('finance.export') && (
          <Button
            variant="outline"
            disabled={exporting}
            onClick={() => void download()}
          >
            {exporting ? 'Exporting…' : 'Export Excel (.xlsx)'}
          </Button>
        )}
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
      ) : !result.data.items.length ? (
        <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
          No receipts in this date range.
        </p>
      ) : (
        <>
          <section className="space-y-4">
            <h2 className="text-lg font-medium">Actual receipts</h2>
            {result.data.items.map((row) => (
              <article
                key={row.id}
                className="flex flex-wrap justify-between gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
              >
                <p className="text-sm">
                  {row.receivedDate} · {row.agentCode} ·{' '}
                  <Link
                    to="/cases/$caseId"
                    params={{ caseId: row.caseId }}
                    className="hover:underline"
                  >
                    {row.customerName}
                  </Link>
                </p>
                <p className="text-sm font-medium tabular-nums">
                  {money(row.receivedAmount)} · 已收款
                </p>
              </article>
            ))}
          </section>
          <section className="space-y-4">
            <h2 className="text-lg font-medium">Return ledger</h2>
            {result.data.items.map((row) => (
              <article
                key={row.id}
                className="flex flex-wrap justify-between gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
              >
                <div>
                  <p className="text-sm">
                    {row.receivedDate} · {row.agentCode} · {row.customerName}
                  </p>
                  <p className="mt-2 text-sm font-medium tabular-nums">
                    {money(row.returnAmount)} · 收 ·{' '}
                    {row.returnStatus === 'pending' ? '尚未回款' : '已回款'}
                  </p>
                </div>
                {permissions.can(
                  row.returnStatus === 'pending'
                    ? 'settlement.mark_returned'
                    : 'settlement.mark_pending',
                ) && (
                  <Button
                    variant="outline"
                    disabled={mark.isPending}
                    onClick={async () => {
                      try {
                        await mark.mutateAsync({
                          id: row.id,
                          expectedVersion: row.version,
                          returnStatus:
                            row.returnStatus === 'pending'
                              ? 'returned'
                              : 'pending',
                        });
                        await refresh();
                      } catch (failure: unknown) {
                        setError(
                          failure instanceof Error
                            ? failure.message
                            : 'Could not update return status.',
                        );
                      }
                    }}
                  >
                    {row.returnStatus === 'pending'
                      ? '標記已回款'
                      : '改回尚未回款'}
                  </Button>
                )}
              </article>
            ))}
          </section>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>
              {result.data.total} receipts · Page {page}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={page * 25 >= result.data.total}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
