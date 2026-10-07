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
  }),
  component: CasesPage,
});
function CasesPage() {
  const permissions = useCasePermissions();
  const { page, query } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: session } = useSession();
  const options = orpc.cases.list.queryOptions({
    input: { page, pageSize: 10, query },
  });
  const result = useQuery({
    ...options,
    queryKey: [session?.user.id, ...options.queryKey],
    enabled: !!session,
    retry: false,
  });
  const pages = Math.max(1, Math.ceil((result.data?.total ?? 0) / 10));
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
              search: { query: event.target.value, page: 1 },
              replace: true,
            })
          }
        />
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
                      void navigate({ search: { query, page: 1 } })
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
                  void navigate({ search: { query, page: page - 1 } })
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
                  void navigate({ search: { query, page: page + 1 } })
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
