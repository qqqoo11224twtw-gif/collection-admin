import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { CaseError, LoadingCases } from '~/components/cases/presentation';
import { orpc } from '~/lib/orpc';
export const Route = createFileRoute('/cases/regions')({
  component: RegionsPage,
});
function RegionsPage() {
  const permissions = useCasePermissions(),
    options = orpc.cases.regions.queryOptions(),
    result = useQuery({
      ...options,
      queryKey: [permissions.userId, ...options.queryKey],
      enabled: permissions.can('case.view'),
    });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">地區調度</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          依地區查看目前派單與未委外案件。
        </p>
      </div>
      {result.isPending ? (
        <LoadingCases />
      ) : result.isError ? (
        <CaseError retry={() => void result.refetch()} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {result.data.map((row) => (
            <article
              key={row.region ?? 'unknown'}
              className="space-y-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
            >
              <h2 className="text-lg font-medium">{row.region ?? '未填寫'}</h2>
              <p className="text-sm tabular-nums">
                {row.total} 筆案件 · 已委外 {row.assigned} · 未委外{' '}
                {row.unassigned}
              </p>
              <div className="flex flex-wrap gap-3 text-sm">
                <Link
                  to="/cases"
                  search={{
                    query: '',
                    page: 1,
                    region: row.region ?? undefined,
                    regionMissing: row.region ? undefined : true,
                  }}
                  className="text-primary hover:underline"
                >
                  查看案件
                </Link>
                {row.region && (
                  <Link
                    to="/cases"
                    search={{
                      query: '',
                      page: 1,
                      region: row.region,
                      assignmentStatus: 'unassigned',
                    }}
                    className="text-primary hover:underline"
                  >
                    未委外案件
                  </Link>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
