import { Card, CardContent } from '@saasflare-dev/ui/components/card';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@saasflare-dev/ui/components/tabs';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { AssignmentPanel } from '~/components/cases/assignment-panel';
import { AuditTimeline } from '~/components/cases/audit-timeline';
import { CaseEditor } from '~/components/cases/case-editor';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { PaymentsPanel } from '~/components/cases/payments-panel';
import {
  CaseError,
  LoadingCases,
  money,
  StatusBadge,
  timestamp,
} from '~/components/cases/presentation';
import { PrivateImages } from '~/components/cases/private-images';
import { ReportsPanel } from '~/components/cases/reports-panel';
import { useSession } from '~/lib/auth';
import { orpc } from '~/lib/orpc';

export const Route = createFileRoute('/cases/$caseId')({
  component: CaseDetail,
});
const placeholders = [{ value: 'payments', label: '收款紀錄' }];
const sources = {
  manual: '人工建檔',
  poster_builder: '製圖小幫手',
  telegram_ai: 'Telegram AI',
  historical_import: '歷史匯入',
};
const revisit = {
  pending: '待確認',
  recommended: '值得二訪',
  not_required: '不需二訪',
  observe: '可再觀察',
  not_recommended: '不建議二訪',
  not_needed: '不需二訪',
};
function CaseDetail() {
  const permissions = useCasePermissions();
  const { caseId } = Route.useParams();
  const { data: session } = useSession();
  const options = orpc.cases.detail.queryOptions({ input: { id: caseId } });
  const result = useQuery({
    ...options,
    queryKey: [session?.user.id, ...options.queryKey],
    enabled: !!session,
    retry: false,
  });
  if (result.isPending) return <LoadingCases />;
  if (result.isError) return <CaseError retry={() => void result.refetch()} />;
  const record = result.data;
  const fields = [
    ['客戶', record.customerName],
    ['案件編號', record.caseNo],
    ['代號', record.code],
    ['地區', record.region ?? '未填寫'],
    ['地址', record.address],
    ['應收款項', money(record.amountDue)],
    ['二訪建議', revisit[record.revisitStatus]],
    ['二訪原因', record.revisitReason || '—'],
    ['來源', sources[record.source]],
    ['建立時間', timestamp(record.createdAt)],
    ['更新時間', timestamp(record.updatedAt)],
  ];
  return (
    <div className="space-y-6">
      {/* Case identity remains visible while changing detail tabs. */}
      <Link
        to="/cases"
        search={{ query: '', page: 1 }}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← 案件列表
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 break-all text-sm font-mono text-muted-foreground">
            {record.caseNo}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {record.customerName}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={record.status} />
          {permissions.can('case.edit') && <CaseEditor record={record} />}
        </div>
      </div>
      <Tabs defaultValue="overview" key={caseId} className="space-y-6">
        <div className="overflow-x-auto pb-2">
          <TabsList variant="line" aria-label="案件詳情">
            <TabsTrigger value="overview" className="text-base">
              概覽
            </TabsTrigger>
            <TabsTrigger value="images" className="text-base">
              委外圖片
            </TabsTrigger>
            <TabsTrigger value="reports" className="text-base">
              回報紀錄
            </TabsTrigger>
            {placeholders.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="text-base"
              >
                {tab.label}
              </TabsTrigger>
            ))}
            <TabsTrigger value="assignments" className="text-base">
              派單紀錄
            </TabsTrigger>
            {permissions.can('audit_log.view') && (
              <TabsTrigger value="activity" className="text-base">
                操作紀錄
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        <TabsContent value="overview">
          <Card>
            <CardContent className="p-6">
              <dl className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                {fields.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="mt-2 break-words text-sm font-medium">
                      {value}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt className="text-sm text-muted-foreground">案件狀態</dt>
                  <dd className="mt-2">
                    <StatusBadge status={record.status} />
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="images">
          <PrivateImages caseId={caseId} version={record.version} />
        </TabsContent>
        <TabsContent value="reports">
          <ReportsPanel caseId={caseId} version={record.version} />
        </TabsContent>
        <TabsContent value="payments">
          <PaymentsPanel caseId={caseId} />
        </TabsContent>
        <TabsContent value="assignments">
          <AssignmentPanel caseId={caseId} version={record.version} />
        </TabsContent>
        <TabsContent value="activity">
          <AuditTimeline caseId={caseId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
