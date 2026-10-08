import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  displayLabel,
  displayMessage,
} from '~/components/cases/display-labels';
import { useCasePermissions } from '~/components/cases/management-hooks';
import {
  CaseError,
  LoadingCases,
  timestamp,
} from '~/components/cases/presentation';
import { orpc } from '~/lib/orpc';
export const reviewTypeLabels = {
  report_classification: '回報分類',
  case_match: '案件配對',
  image_extraction: '圖片辨識',
  payment_detection: '收款判斷',
};
export const Route = createFileRoute('/cases/reviews/')({
  validateSearch: (search: Record<string, unknown>) => ({
    page: Math.max(1, Math.min(100000, Math.floor(Number(search.page) || 1))),
    query: typeof search.query === 'string' ? search.query.slice(0, 120) : '',
    status: ['pending', 'approved', 'corrected', 'rejected'].includes(
      String(search.status),
    )
      ? String(search.status)
      : 'pending',
    type: Object.keys(reviewTypeLabels).includes(String(search.type))
      ? String(search.type)
      : '',
  }),
  component: ReviewCenter,
});
function ReviewCenter() {
  const permissions = useCasePermissions();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const options = orpc.reviews.list.queryOptions({
    input: {
      page: search.page,
      pageSize: 10,
      query: search.query,
      status: search.status as
        | 'pending'
        | 'approved'
        | 'corrected'
        | 'rejected',
      reviewType: search.type
        ? (search.type as keyof typeof reviewTypeLabels)
        : undefined,
    },
  });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('review.view'),
  });
  if (permissions.isPending) return <LoadingCases />;
  if (!permissions.can('review.view'))
    return (
      <p className="text-sm text-muted-foreground">無待確認中心查看權限。</p>
    );
  const update = (values: Partial<typeof search>) =>
    void navigate({ search: { ...search, ...values, page: 1 } });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">待確認</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          資料不確定時，請先人工確認再更新正式案件。
        </p>
      </div>
      {/* Search and filters stay independent from the review decision workflow. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="review-search">搜尋待確認項目</Label>
          <Input
            id="review-search"
            value={search.query}
            onChange={(e) => update({ query: e.target.value })}
            placeholder="客戶、案件或原因"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="review-type">確認類型</Label>
          <select
            id="review-type"
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={search.type}
            onChange={(e) => update({ type: e.target.value })}
          >
            <option value="">全部類型</option>
            {Object.entries(reviewTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="review-status">確認狀態</Label>
          <select
            id="review-status"
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={search.status}
            onChange={(e) => update({ status: e.target.value })}
          >
            {['pending', 'approved', 'corrected', 'rejected'].map((s) => (
              <option key={s} value={s}>
                {s === 'pending' ? '待確認' : displayLabel(s)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {result.isPending ? (
        <LoadingCases />
      ) : result.isError ? (
        <CaseError retry={() => void result.refetch()} />
      ) : (
        <>
          {!result.data.items.length ? (
            <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
              沒有符合條件的待確認項目。
            </p>
          ) : (
            <ul className="space-y-4">
              {result.data.items.map((item) => (
                <li
                  key={item.id}
                  className="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
                >
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <Link
                        to="/cases/reviews/$reviewId"
                        params={{ reviewId: item.id }}
                        className="text-base font-medium hover:underline"
                      >
                        {reviewTypeLabels[item.reviewType]}
                      </Link>
                      <p className="mt-2 text-sm">
                        {item.customerName ??
                          item.lookupValue ??
                          '需要選擇案件'}
                        {item.caseNo && (
                          <span className="ml-2 break-all text-muted-foreground">
                            {item.caseNo}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-start gap-2">
                      <Badge variant="secondary">
                        {item.status === 'pending'
                          ? '待確認'
                          : displayLabel(item.status)}
                      </Badge>
                      <Badge variant="outline">優先級 {item.priority}</Badge>
                    </div>
                  </div>
                  <p className="mt-4 break-words text-sm text-muted-foreground">
                    {displayMessage(item.reason)}
                  </p>
                  <p className="mt-3 text-sm text-muted-foreground">
                    信心值：{' '}
                    {item.confidence === null
                      ? '未提供'
                      : `${Math.round(item.confidence * 100)}%`}{' '}
                    · {displayLabel(item.source)} · {timestamp(item.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {result.data.total} 筆待確認項目 · 第 {search.page}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={search.page === 1}
                onClick={() =>
                  void navigate({
                    search: { ...search, page: search.page - 1 },
                  })
                }
              >
                上一頁
              </Button>
              <Button
                variant="outline"
                disabled={search.page * 10 >= result.data.total}
                onClick={() =>
                  void navigate({
                    search: { ...search, page: search.page + 1 },
                  })
                }
              >
                下一頁
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
