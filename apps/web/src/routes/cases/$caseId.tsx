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
const placeholders = [{ value: 'payments', label: 'Payment history' }];
const sources = {
  manual: 'Manual',
  poster_builder: 'Poster builder',
  telegram_ai: 'Telegram AI',
  historical_import: 'Historical import',
};
const revisit = {
  pending: 'Pending review',
  recommended: 'Recommended',
  not_required: 'Not required',
  observe: 'Observe',
  not_recommended: 'Not recommended',
  not_needed: 'Not needed',
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
    ['Customer', record.customerName],
    ['Case no.', record.caseNo],
    ['Code', record.code],
    ['Region', record.region ?? 'Not recorded'],
    ['Address', record.address],
    ['Amount due', money(record.amountDue)],
    ['Revisit recommendation', revisit[record.revisitStatus]],
    ['Revisit reason', record.revisitReason || '—'],
    ['Source', sources[record.source]],
    ['Created', timestamp(record.createdAt)],
    ['Updated', timestamp(record.updatedAt)],
  ];
  return (
    <div className="space-y-6">
      {/* Case identity remains visible while changing detail tabs. */}
      <Link
        to="/cases"
        search={{ query: '', page: 1 }}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← All cases
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
          <TabsList variant="line" aria-label="Case details">
            <TabsTrigger value="overview" className="text-base">
              Overview
            </TabsTrigger>
            <TabsTrigger value="images" className="text-base">
              Outsourcing images
            </TabsTrigger>
            <TabsTrigger value="reports" className="text-base">
              Report history
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
              Assignment history
            </TabsTrigger>
            {permissions.can('audit_log.view') && (
              <TabsTrigger value="activity" className="text-base">
                Activity log
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
                  <dt className="text-sm text-muted-foreground">Status</dt>
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
