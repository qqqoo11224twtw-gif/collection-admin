import { REGIONS } from '@saasflare-dev/api/regions';
import { Button } from '@saasflare-dev/ui/components/button';
import { Checkbox } from '@saasflare-dev/ui/components/checkbox';
import { Input } from '@saasflare-dev/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@saasflare-dev/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { BulkAssignmentDialog } from '~/components/cases/bulk-assignment-dialog';
import { BulkEditDialog } from '~/components/cases/bulk-edit-dialog';
import { CaseEditor } from '~/components/cases/case-editor';
import { displayLabel } from '~/components/cases/display-labels';
import { useCasePermissions } from '~/components/cases/management-hooks';
import type { CaseRecord } from '~/components/cases/presentation';
import {
  CaseError,
  LoadingCases,
  money,
  StatusBadge,
  timestamp,
} from '~/components/cases/presentation';
import { useSession } from '~/lib/auth';
import { orpc } from '~/lib/orpc';
import { useMobile } from '~/lib/use-mobile';

export const Route = createFileRoute('/cases/')({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.voided === true || search.voided === 'true'
      ? { voided: true }
      : {}),
    page: Math.max(1, Math.min(100000, Math.floor(Number(search.page) || 1))),
    ...([20, 50, 200, 500].includes(Number(search.pageSize))
      ? { pageSize: Number(search.pageSize) as 20 | 50 | 200 | 500 }
      : {}),
    query: typeof search.query === 'string' ? search.query.slice(0, 120) : '',
    ...(search.regionMissing === true || search.regionMissing === 'true'
      ? { regionMissing: true }
      : {}),
    ...(REGIONS.includes(search.region as (typeof REGIONS)[number])
      ? { region: search.region as (typeof REGIONS)[number] }
      : {}),
    ...(typeof search.collectorId === 'string' && search.collectorId
      ? { collectorId: search.collectorId }
      : {}),
    ...(search.assignmentStatus === 'assigned' ||
    search.assignmentStatus === 'unassigned'
      ? {
          assignmentStatus: search.assignmentStatus as
            | 'assigned'
            | 'unassigned',
        }
      : {}),
    ...([
      'pending',
      'assigned',
      'follow_up',
      'installment',
      'settled',
      'unresolved',
    ].includes(String(search.status))
      ? { status: search.status as CaseRecord['status'] }
      : {}),
  }),
  component: CasesPage,
});
function CasesPage() {
  const mobile = useMobile();
  const permissions = useCasePermissions();
  const search = Route.useSearch();
  const { page, pageSize = 20, query } = search;
  const navigate = Route.useNavigate();
  const { data: session } = useSession();
  const selectionKey = JSON.stringify([session?.user.id, search]);
  const [selection, setSelection] = useState<{ key: string; ids: string[] }>({
    key: '',
    ids: [],
  });
  const selected = selection.key === selectionKey ? selection.ids : [];
  const canAssign =
    permissions.can('assignment.create') && permissions.can('assignment.bulk');
  const canSelect =
    canAssign || permissions.can('case.edit') || permissions.can('case.delete');
  const options = orpc.cases.list.queryOptions({
    input: { ...search, pageSize },
  });
  const result = useQuery({
    ...options,
    queryKey: [session?.user.id, ...options.queryKey],
    enabled: !!session,
    retry: false,
  });
  const pages = Math.max(1, Math.ceil((result.data?.total ?? 0) / pageSize));
  const selectable =
    result.data?.items
      .filter(
        (record) =>
          canSelect &&
          !record.voidedAt &&
          (permissions.can('case.edit') ||
            permissions.can('case.delete') ||
            !record.isAssigned),
      )
      .map((record) => record.id) ?? [];
  const allSelected =
    selectable.length > 0 && selectable.every((id) => selected.includes(id));
  const collectorOptions = orpc.collectors.choices.queryOptions();
  const collectors = useQuery({
    ...collectorOptions,
    queryKey: [permissions.userId, ...collectorOptions.queryKey],
    enabled: permissions.can('case.view'),
  });
  return (
    <div className={selected.length ? 'space-y-6 pb-24 lg:pb-0' : 'space-y-6'}>
      {/* Page heading and lightweight search, without dashboard statistics. */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">案件管理</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            查看案件、委外狀態與後續追蹤事項。
          </p>
        </div>
        {permissions.can('case.create') && (
          <div className="flex flex-wrap gap-2">
            <CaseEditor />
            <Button variant="outline" asChild>
              <Link to="/cases/bulk-create">批量建檔</Link>
            </Button>
          </div>
        )}
        {permissions.can('case.search') && (
          <Input
            aria-label="搜尋案件"
            placeholder="搜尋姓名、代號、案件編號或地址"
            className="md:max-w-sm"
            maxLength={120}
            value={query}
            onChange={(event) =>
              void navigate({
                search: { ...search, query: event.target.value, page: 1 },
                replace: true,
              })
            }
          />
        )}
      </div>
      {/* Filters compose against current assignments rather than a textual case status. */}
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        每頁顯示
        <select
          aria-label="每頁顯示"
          className="h-9 rounded-md border border-input bg-background px-2 text-foreground"
          value={pageSize}
          onChange={(event) =>
            void navigate({
              search: {
                ...search,
                page: 1,
                pageSize: Number(event.target.value) as 20 | 50 | 200 | 500,
              },
            })
          }
        >
          {[20, 50, 200, 500].map((size) => (
            <option key={size} value={size}>
              {size} 條/頁
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            key: 'region',
            label: '地區',
            choices: [
              ...REGIONS.map((value) => ({ value, label: value })),
              { value: '__missing__', label: '未填寫' },
            ],
          },
          {
            key: 'collectorId',
            label: '外收人員',
            choices:
              collectors.data?.map((c) => ({
                value: c.id,
                label: c.displayName,
              })) ?? [],
          },
          {
            key: 'assignmentStatus',
            label: '委外狀態',
            choices: [
              { value: 'assigned', label: '已委外' },
              { value: 'unassigned', label: '未委外' },
            ],
          },
          {
            key: 'status',
            label: '案件狀態',
            choices: [
              'pending',
              'assigned',
              'follow_up',
              'installment',
              'settled',
              'unresolved',
            ].map((value) => ({ value, label: displayLabel(value) })),
          },
        ].map((filter) => (
          <select
            key={filter.key}
            aria-label={filter.label}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={
              filter.key === 'region' && search.regionMissing
                ? '__missing__'
                : String(search[filter.key as keyof typeof search] ?? '')
            }
            onChange={(event) =>
              void navigate({
                search: {
                  ...search,
                  [filter.key]:
                    event.target.value === '__missing__'
                      ? undefined
                      : event.target.value || undefined,
                  ...(filter.key === 'region'
                    ? {
                        regionMissing:
                          event.target.value === '__missing__'
                            ? true
                            : undefined,
                      }
                    : {}),
                  page: 1,
                },
                replace: true,
              })
            }
          >
            <option value="">
              全部 · {filter.label.replace(' filter', '')}
            </option>
            {filter.choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        ))}
      </div>
      <fieldset
        aria-label="案件狀態篩選"
        className="flex min-w-0 gap-2 overflow-x-auto pb-2"
      >
        {[
          { label: '全部' },
          { label: '未委外', assignmentStatus: 'unassigned' },
          { label: '已委外', assignmentStatus: 'assigned' },
          { label: '分期', status: 'installment' },
          { label: '結清', status: 'settled' },
          { label: '二訪', status: 'follow_up' },
          { label: '無解', status: 'unresolved' },
          { label: '已作廢', voided: true },
        ].map((tab) => (
          <Button
            key={tab.label}
            variant={
              !!search.voided === !!tab.voided &&
              search.status === tab.status &&
              search.assignmentStatus === tab.assignmentStatus
                ? 'default'
                : 'outline'
            }
            className="shrink-0"
            onClick={() =>
              void navigate({
                search: {
                  ...search,
                  page: 1,
                  voided: !!tab.voided,
                  status: tab.status as CaseRecord['status'] | undefined,
                  assignmentStatus: tab.assignmentStatus as
                    | 'assigned'
                    | 'unassigned'
                    | undefined,
                },
              })
            }
          >
            {tab.label}
          </Button>
        ))}
      </fieldset>
      {canSelect && (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3 ${selected.length ? 'fixed inset-x-4 bottom-24 z-20 shadow-lg lg:static' : ''}`}
        >
          <output
            aria-label="已選案件"
            className="text-sm text-muted-foreground"
          >
            已選取 {selected.length} 筆案件 · 選取範圍限目前頁面與篩選條件。
          </output>
          <div className="flex flex-wrap gap-2">
            {permissions.can('case.edit') && (
              <BulkEditDialog
                caseIds={selected}
                onDone={() => setSelection({ key: selectionKey, ids: [] })}
              />
            )}
            {canAssign && (
              <BulkAssignmentDialog
                caseIds={selected}
                onAssigned={() => setSelection({ key: selectionKey, ids: [] })}
              />
            )}
            {permissions.can('case.delete') && (
              <BulkEditDialog
                voidMode
                caseIds={selected}
                onDone={() => setSelection({ key: selectionKey, ids: [] })}
              />
            )}
          </div>
        </div>
      )}
      {result.isPending ? (
        <LoadingCases />
      ) : result.isError ? (
        <CaseError retry={() => void result.refetch()} />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10">
            {result.data.items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
                <FolderOpen className="size-8 text-muted-foreground" />
                <h2 className="text-lg font-medium">找不到案件</h2>
                <p className="text-sm text-muted-foreground">
                  請嘗試其他搜尋條件，或請管理員指派案件。
                </p>
                {query && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      void navigate({ search: { query: '', page: 1 } })
                    }
                  >
                    清除篩選
                  </Button>
                )}
                {page > 1 && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      void navigate({ search: { ...search, page: 1 } })
                    }
                  >
                    第一頁
                  </Button>
                )}
              </div>
            ) : (
              <>
                {mobile && (
                  <div className="space-y-3 p-3">
                    {canSelect && (
                      <div className="flex items-center gap-3 p-2 text-sm">
                        <Checkbox
                          aria-label="全選目前頁面"
                          checked={allSelected}
                          disabled={!selectable.length}
                          onCheckedChange={(checked) =>
                            setSelection({
                              key: selectionKey,
                              ids: checked ? selectable : [],
                            })
                          }
                        />
                        全選目前頁面
                      </div>
                    )}
                    {result.data.items.map((record) => (
                      <article
                        key={record.id}
                        className="rounded-xl border bg-background/40 p-4"
                      >
                        <div className="flex items-start gap-3">
                          {canSelect && (
                            <Checkbox
                              aria-label={`選取 ${record.caseNo}`}
                              checked={selected.includes(record.id)}
                              disabled={!selectable.includes(record.id)}
                              onCheckedChange={(checked) =>
                                setSelection({
                                  key: selectionKey,
                                  ids: checked
                                    ? [...selected, record.id]
                                    : selected.filter((id) => id !== record.id),
                                })
                              }
                            />
                          )}
                          <Link
                            to="/cases/$caseId"
                            params={{ caseId: record.id }}
                            className="min-w-0 flex-1"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium">{record.code}</span>
                              {record.voidedAt ? (
                                <span className="text-sm text-destructive">
                                  已作廢
                                </span>
                              ) : (
                                <StatusBadge status={record.status} />
                              )}
                            </div>
                            <h2 className="mt-2 text-lg font-medium">
                              {record.customerName}
                            </h2>
                            <p className="mt-3 text-sm text-muted-foreground">
                              {record.region ?? '未填寫地區'} ·{' '}
                              {record.currentCollectorName ?? '未委外'}
                            </p>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {timestamp(record.createdAt)}
                            </p>
                          </Link>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                {!mobile && (
                  <div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {canSelect && (
                            <TableHead className="w-12 px-4">
                              <Checkbox
                                aria-label="全選目前頁面"
                                disabled={!selectable.length}
                                checked={
                                  allSelected
                                    ? true
                                    : selected.length
                                      ? 'indeterminate'
                                      : false
                                }
                                onCheckedChange={(checked) =>
                                  setSelection({
                                    key: selectionKey,
                                    ids: checked ? selectable : [],
                                  })
                                }
                              />
                            </TableHead>
                          )}
                          <TableHead className="px-4">客戶</TableHead>
                          <TableHead>代號</TableHead>
                          <TableHead>案件編號</TableHead>
                          <TableHead>案件狀態</TableHead>
                          <TableHead className="text-right">應收款項</TableHead>
                          <TableHead>地區／外收人員</TableHead>
                          <TableHead className="px-4 text-right">
                            更新時間
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.data.items.map((record) => (
                          <TableRow key={record.id}>
                            {canSelect && (
                              <TableCell className="px-4">
                                <Checkbox
                                  aria-label={`選取 ${record.caseNo}`}
                                  disabled={!selectable.includes(record.id)}
                                  checked={selected.includes(record.id)}
                                  onCheckedChange={(checked) =>
                                    setSelection({
                                      key: selectionKey,
                                      ids: checked
                                        ? [...selected, record.id]
                                        : selected.filter(
                                            (id) => id !== record.id,
                                          ),
                                    })
                                  }
                                />
                              </TableCell>
                            )}
                            <TableCell className="px-4 py-4 font-medium">
                              <Link
                                to="/cases/$caseId"
                                params={{ caseId: record.id }}
                                className="block max-w-44 truncate hover:underline focus-visible:underline"
                                title={record.customerName}
                              >
                                {record.customerName}
                              </Link>
                            </TableCell>
                            <TableCell className="font-mono text-muted-foreground">
                              {record.code}
                            </TableCell>
                            <TableCell>
                              <Link
                                to="/cases/$caseId"
                                params={{ caseId: record.id }}
                                className="block max-w-44 truncate font-mono hover:underline"
                                title={record.caseNo}
                              >
                                {record.caseNo}
                              </Link>
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={record.status} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {money(record.amountDue)}
                            </TableCell>
                            <TableCell>
                              <p>{record.region ?? '未填寫'}</p>
                              <p className="mt-1 text-muted-foreground">
                                {record.currentCollectorName ?? '未委外'}
                              </p>
                            </TableCell>
                            <TableCell className="px-4 text-right text-muted-foreground">
                              {timestamp(record.updatedAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p>
              {result.data.total} 筆案件 · 第 {page} ／ {pages}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                aria-label="上一頁"
                disabled={page <= 1}
                onClick={() =>
                  void navigate({ search: { ...search, page: page - 1 } })
                }
              >
                <ChevronLeft className="size-4" />
                上一頁
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label="下一頁"
                disabled={page >= pages}
                onClick={() =>
                  void navigate({ search: { ...search, page: page + 1 } })
                }
              >
                下一頁
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
