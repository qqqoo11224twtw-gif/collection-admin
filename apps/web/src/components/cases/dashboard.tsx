import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowUpRight,
  CircleCheck,
  Clock,
  FolderOpen,
  ShieldCheck,
} from 'lucide-react';
import { orpc } from '~/lib/orpc';
import { useCasePermissions } from './management-hooks';
import {
  CaseError,
  LoadingCases,
  StatusBadge,
  timestamp,
} from './presentation';

export function Dashboard() {
  const permissions = useCasePermissions();
  const all = useQuery({
    ...orpc.cases.list.queryOptions({ input: { pageSize: 20 } }),
    enabled: permissions.can('case.view'),
  });
  const settled = useQuery({
    ...orpc.cases.list.queryOptions({
      input: { status: 'settled', pageSize: 20 },
    }),
    enabled: permissions.can('case.view'),
  });
  const unassigned = useQuery({
    ...orpc.cases.list.queryOptions({
      input: { assignmentStatus: 'unassigned', pageSize: 20 },
    }),
    enabled: permissions.can('case.view'),
  });
  const review = useQuery({
    ...orpc.reviews.pendingCount.queryOptions(),
    enabled: permissions.can('review.view') && permissions.can('case.view'),
  });
  return (
    <div className="space-y-8">
      <header>
        <p className="mb-2 text-sm text-muted-foreground">工作空間</p>
        <h1 className="text-2xl font-semibold">儀表總覽</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          掌握案件進度，快速前往需要處理的工作。
        </p>
      </header>
      <section
        aria-label="工作摘要"
        className="grid grid-cols-2 gap-4 xl:grid-cols-4"
      >
        {[
          {
            label: '全部案件',
            value: all.data?.total,
            icon: FolderOpen,
            visible: permissions.can('case.view'),
          },
          {
            label: '待委外',
            value: unassigned.data?.total,
            icon: Clock,
            visible: permissions.can('case.view'),
          },
          {
            label: '已結清',
            value: settled.data?.total,
            icon: CircleCheck,
            visible: permissions.can('case.view'),
          },
          {
            label: '待確認',
            value: review.data,
            icon: ShieldCheck,
            visible:
              permissions.can('review.view') && permissions.can('case.view'),
          },
        ]
          .filter((item) => item.visible)
          .map(({ label, value, icon: Icon }) => (
            <article key={label} className="rounded-xl border bg-card p-5">
              <Icon className="mb-5 size-5 text-primary" />
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {value ?? '—'}
              </p>
            </article>
          ))}
      </section>
      {permissions.can('case.view') && (
        <section className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b p-5">
            <h2 className="text-lg font-medium">最近案件</h2>
            <Link
              to="/cases"
              search={{ page: 1, query: '' }}
              className="flex items-center gap-2 text-sm text-primary"
            >
              查看全部
              <ArrowUpRight className="size-4" />
            </Link>
          </div>
          {all.isPending ? (
            <div className="p-5">
              <LoadingCases />
            </div>
          ) : all.isError ? (
            <CaseError retry={() => void all.refetch()} />
          ) : !all.data.items.length ? (
            <p className="p-8 text-sm text-muted-foreground">目前沒有資料</p>
          ) : (
            <div className="divide-y">
              {all.data.items.slice(0, 5).map((record) => (
                <Link
                  key={record.id}
                  to="/cases/$caseId"
                  params={{ caseId: record.id }}
                  className="flex flex-wrap items-center justify-between gap-3 p-5 hover:bg-muted/40"
                >
                  <div>
                    <p className="font-medium">{record.customerName}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {record.code} · {record.region ?? '未填寫地區'}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <StatusBadge status={record.status} />
                    <span className="hidden text-sm text-muted-foreground sm:inline">
                      {timestamp(record.updatedAt)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
