import { useQuery } from '@tanstack/react-query';
import { orpc } from '~/lib/orpc';
import { useCasePermissions } from './management-hooks';
import { CaseError, LoadingCases, timestamp } from './presentation';

const actionLabels: Record<string, string> = {
  'manual.case_created': 'Case created',
  'manual.image_uploaded': 'Finished images uploaded',
  duplicate_warning_overridden: 'Duplicate warning overridden',
  'case.region_changed': 'Region corrected',
  'case.customer_code_corrected': 'Customer or code corrected',
  'assignment.corrected': 'Historical collector corrected',
  'installment.plan_created': 'Installment plan created',
  'installment.plan_cancelled': 'Installment plan cancelled',
  'installment.workflow_started': 'Installment setup started',
  'installment.workflow_advanced': 'Installment setup updated',
  'installment.workflow_cancelled': 'Installment setup cancelled',
  'payment.received': 'Payment received',
  'payment.voided': 'Payment voided',
  'settlement.created': 'Return ledger entry created',
  'settlement.marked_returned': 'Marked returned',
  'settlement.marked_pending': 'Marked pending return',
  'review.created': 'Review created',
  'review.approved': 'Review approved',
  'review.corrected': 'Review corrected',
  'review.rejected': 'Review rejected',
  'report.created': 'Report created',
  'report.edited': 'Report edited',
  'case.created': 'Case created',
  'case.edited': 'Case edited',
  'assignment.created': 'Case assigned',
  'assignment.reassigned': 'Case reassigned',
  'assignment.unassigned': 'Assignment removed',
  'media.uploaded': 'Images uploaded',
  'media.reordered': 'Images reordered',
  'media.deleted': 'Image deleted',
};

export function AuditTimeline({ caseId }: { caseId: string }) {
  const permissions = useCasePermissions();
  const options = orpc.cases.audit.queryOptions({ input: { id: caseId } });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('audit_log.view'),
  });
  if (!permissions.can('audit_log.view'))
    return (
      <p className="text-sm text-muted-foreground">
        You do not have access to the activity log.
      </p>
    );
  if (result.isPending) return <LoadingCases />;
  if (result.isError) return <CaseError retry={() => void result.refetch()} />;
  if (!result.data.length)
    return (
      <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
        No recorded activity yet.
      </p>
    );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Latest 100 events · Event details contain field names and identifiers
        only.
      </p>
      <ol className="space-y-4 border-l border-border pl-5">
        {result.data.map((item) => (
          <li
            key={item.id}
            className="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
          >
            <p className="text-base font-medium">
              {actionLabels[item.action] ?? item.action}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {item.actor ?? 'Former user'} · {timestamp(item.createdAt)}
            </p>
            <details className="mt-3 text-sm text-muted-foreground">
              <summary className="cursor-pointer">Event details</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs">
                {item.metadata}
              </pre>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
