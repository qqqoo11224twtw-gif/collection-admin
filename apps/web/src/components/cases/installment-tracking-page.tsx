import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { orpc } from '~/lib/orpc';
import { useCasePermissions } from './management-hooks';
import { CaseError, LoadingCases, timestamp } from './presentation';

export function InstallmentTrackingPage() {
  const permissions = useCasePermissions();
  const [query, setQuery] = useState(''),
    [region, setRegion] = useState(''),
    [collectorId, setCollectorId] = useState(''),
    [dateFrom, setDateFrom] = useState(''),
    [dateTo, setDateTo] = useState(''),
    [page, setPage] = useState(1);
  const enabled =
    permissions.can('case.view') && permissions.can('installment.view');
  const options = orpc.installments.trackingList.queryOptions({
    input: {
      query,
      region,
      page,
      pageSize: 20,
      ...(collectorId ? { collectorId } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    },
  });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled,
    refetchInterval: 15000,
  });
  const collectors = useQuery({
    ...orpc.collectors.choices.queryOptions(),
    enabled: enabled && permissions.can('case.view_all'),
  });
  if (permissions.isPending) return <LoadingCases />;
  if (!enabled) return <p>無操作權限</p>;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">分期客追蹤</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          目前標記分期且有效委外的案件，以最新回報追蹤。
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          aria-label="搜尋分期案件"
          placeholder="搜尋姓名或代號"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <Input
          aria-label="分期地區"
          placeholder="地區"
          value={region}
          onChange={(e) => {
            setRegion(e.target.value);
            setPage(1);
          }}
        />
        {permissions.can('case.view_all') && (
          <select
            aria-label="分期外收人員"
            className="h-9 min-w-0 rounded-md border bg-background px-3"
            value={collectorId}
            onChange={(e) => {
              setCollectorId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">所有外收人員</option>
            {collectors.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        )}
        <label className="text-sm" htmlFor="tracking-from">
          最後回報起日
          <Input
            aria-label="最後回報起日"
            id="tracking-from"
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="text-sm" htmlFor="tracking-to">
          最後回報迄日
          <Input
            aria-label="最後回報迄日"
            id="tracking-to"
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      {result.isPending ? (
        <LoadingCases />
      ) : result.isError ? (
        <CaseError retry={() => void result.refetch()} />
      ) : !result.data.items.length ? (
        <p className="rounded-xl border bg-card p-8 text-sm text-muted-foreground">
          目前沒有符合條件的分期案件。
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            共 {result.data.total} 件
          </p>
          <div className="space-y-3">
            {result.data.items.map((row) => (
              <article
                key={row.id}
                className="rounded-xl border bg-card p-4 md:p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to="/cases/$caseId"
                      params={{ caseId: row.id }}
                      className="break-words font-medium text-primary"
                    >
                      {row.code} · {row.customerName}
                    </Link>
                    <p className="mt-1 text-sm text-muted-foreground">
                      地區：{row.region || '未設定'}
                      {permissions.can('case.view_all')
                        ? ` · 外收：${row.collectorName}`
                        : ''}
                    </p>
                  </div>
                  <span className="rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">
                    分期
                  </span>
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm">
                  最新回報：{row.latestReport || '尚無回報'}
                </p>
                <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm">
                  <p className="text-muted-foreground">
                    最後回報：
                    {row.lastReportAt
                      ? timestamp(new Date(row.lastReportAt))
                      : '尚無回報'}
                  </p>
                  <Link to="/cases/$caseId" params={{ caseId: row.id }}>
                    查看案件
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          disabled={page === 1}
          onClick={() => setPage((p) => p - 1)}
        >
          上一頁
        </Button>
        <span>第 {page} 頁</span>
        <Button
          variant="outline"
          disabled={result.isPending || page * 20 >= (result.data?.total ?? 0)}
          onClick={() => setPage((p) => p + 1)}
        >
          下一頁
        </Button>
      </div>
    </div>
  );
}
