import { REGIONS } from '@saasflare-dev/api/regions';
import { Button } from '@saasflare-dev/ui/components/button';
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
import { CaseEditor } from '~/components/cases/case-editor';
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

export const Route = createFileRoute('/cases/')({
  validateSearch: (search: Record<string, unknown>) => ({
    page: Math.max(1, Math.min(100000, Math.floor(Number(search.page) || 1))),
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
  const permissions = useCasePermissions();
  const search = Route.useSearch();
  const { page, query } = search;
  const navigate = Route.useNavigate();
  const { data: session } = useSession();
  const options = orpc.cases.list.queryOptions({
    input: { ...search, pageSize: 10 },
  });
  const result = useQuery({
    ...options,
    queryKey: [session?.user.id, ...options.queryKey],
    enabled: !!session,
    retry: false,
  });
  const pages = Math.max(1, Math.ceil((result.data?.total ?? 0) / 10));
  const collectorOptions = orpc.collectors.choices.queryOptions();
  const collectors = useQuery({
    ...collectorOptions,
    queryKey: [permissions.userId, ...collectorOptions.queryKey],
    enabled: permissions.can('case.view'),
  });
  return (
    <div className="space-y-6">
      {/* Page heading and lightweight search, without dashboard statistics. */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cases</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            A clear view of your assigned work and next follow-up.
          </p>
        </div>
        {permissions.can('case.create') && <CaseEditor />}
        <Input
          aria-label="Filter cases"
          placeholder="Filter name, code, case no. or address"
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
      </div>
      {/* Filters compose against current assignments rather than a textual case status. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            key: 'region',
            label: 'Region filter',
            choices: [
              ...REGIONS.map((value) => ({ value, label: value })),
              { value: '__missing__', label: 'Not recorded' },
            ],
          },
          {
            key: 'collectorId',
            label: 'Collector filter',
            choices:
              collectors.data?.map((c) => ({
                value: c.id,
                label: c.displayName,
              })) ?? [],
          },
          {
            key: 'assignmentStatus',
            label: 'Assignment filter',
            choices: [
              { value: 'assigned', label: 'Assigned' },
              { value: 'unassigned', label: 'Unassigned' },
            ],
          },
          {
            key: 'status',
            label: 'Case status filter',
            choices: [
              'pending',
              'assigned',
              'follow_up',
              'installment',
              'settled',
              'unresolved',
            ].map((value) => ({ value, label: value.replaceAll('_', ' ') })),
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
              All · {filter.label.replace(' filter', '')}
            </option>
            {filter.choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        ))}
      </div>
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
                <h2 className="text-lg font-medium">No cases found</h2>
                <p className="text-sm text-muted-foreground">
                  Try another search, or ask an administrator to assign a case.
                </p>
                {query && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      void navigate({ search: { query: '', page: 1 } })
                    }
                  >
                    Clear filter
                  </Button>
                )}
                {page > 1 && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      void navigate({ search: { ...search, page: 1 } })
                    }
                  >
                    First page
                  </Button>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4">Customer</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Case no.</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount due</TableHead>
                    <TableHead>Region / Collector</TableHead>
                    <TableHead className="px-4 text-right">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.data.items.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell className="px-4 py-4 font-medium">
                        <Link
                          to="/cases/$caseId"
                          params={{ caseId: record.id }}
                          className="hover:underline focus-visible:underline"
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
                          className="font-mono hover:underline"
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
                        <p>{record.region ?? 'Not recorded'}</p>
                        <p className="mt-1 text-muted-foreground">
                          {record.currentCollectorName ?? 'Unassigned'}
                        </p>
                      </TableCell>
                      <TableCell className="px-4 text-right text-muted-foreground">
                        {timestamp(record.updatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p>
              {result.data.total} cases · Page {page} of {pages}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() =>
                  void navigate({ search: { ...search, page: page - 1 } })
                }
              >
                <ChevronLeft className="size-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label="Next page"
                disabled={page >= pages}
                onClick={() =>
                  void navigate({ search: { ...search, page: page + 1 } })
                }
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
