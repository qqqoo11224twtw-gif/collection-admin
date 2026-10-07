import type { AppRouterClient } from '@saasflare-dev/api';
import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import { Skeleton } from '@saasflare-dev/ui/components/skeleton';
import { cn } from '@saasflare-dev/ui/lib/utils';

export type CaseRecord = Awaited<
  ReturnType<AppRouterClient['cases']['detail']>
>;
export const statusLabels = {
  pending: 'Pending',
  assigned: 'Assigned',
  follow_up: 'Follow-up',
  installment: 'Installment',
  settled: 'Settled',
  unresolved: 'Unresolved',
};
const colors = {
  pending: 'bg-muted text-muted-foreground',
  assigned: 'bg-info/10 text-info',
  follow_up: 'bg-warning/10 text-warning',
  installment: 'bg-info/10 text-info',
  settled: 'bg-success/10 text-success',
  unresolved: 'bg-destructive/10 text-destructive',
};
export function StatusBadge({ status }: { status: CaseRecord['status'] }) {
  return (
    <Badge variant="secondary" className={cn(colors[status])}>
      {statusLabels[status]}
    </Badge>
  );
}
export function money(value: number) {
  return new Intl.NumberFormat('zh-TW', {
    style: 'currency',
    currency: 'TWD',
    maximumFractionDigits: 0,
  }).format(value);
}
export function timestamp(value: Date | string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
export function LoadingCases() {
  return (
    <output aria-label="Loading cases" className="block space-y-4">
      <span className="sr-only">Loading cases…</span>
      {[1, 2, 3, 4].map((id) => (
        <Skeleton key={id} className="h-12 w-full" />
      ))}
    </output>
  );
}
export function CaseError({ retry }: { retry: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-xl bg-destructive/5 p-8 text-center space-y-3"
    >
      <p className="text-sm text-destructive">
        Unable to load this content. It may be unavailable or outside your
        access.
      </p>
      <Button variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
