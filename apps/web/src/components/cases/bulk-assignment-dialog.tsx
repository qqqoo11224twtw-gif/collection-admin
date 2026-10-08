import type { AppRouterClient } from '@saasflare-dev/api';
import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@saasflare-dev/ui/components/dialog';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { orpc } from '~/lib/orpc';
import { useCasePermissions, useRefreshCases } from './management-hooks';

type Result = Awaited<ReturnType<AppRouterClient['cases']['bulkAssign']>>;
const reasons: Record<string, string> = {
  ALREADY_ASSIGNED: 'Already assigned by another operator',
  CASE_UNAVAILABLE: 'Case unavailable or access denied',
  ROUTE_UNAVAILABLE: 'Telegram route unavailable',
  RECORD_CHANGED: 'Record or routing changed; refresh before trying again',
  SAVE_FAILED: 'This case could not be saved',
  INVALID_CASE_DATA: 'Case data exceeds the Telegram message limit',
};
export function BulkAssignmentDialog({
  caseIds,
  onAssigned,
}: {
  caseIds: string[];
  onAssigned: () => void;
}) {
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const [open, setOpen] = useState(false);
  const [collectorId, setCollectorId] = useState('');
  const [request, setRequest] = useState<{
    batchId: string;
    caseIds: string[];
  } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const mutation = useMutation(orpc.cases.bulkAssign.mutationOptions());
  const options = orpc.cases.bulkAssignmentCollectors.queryOptions();
  const collectors = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: open && !result,
  });
  const resultOptions = orpc.cases.bulkAssignmentResult.queryOptions({
    input: { batchId: result?.batchId ?? '' },
  });
  const live = useQuery({
    ...resultOptions,
    queryKey: [permissions.userId, ...resultOptions.queryKey],
    enabled: open && !!result,
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (item) =>
          item.status === 'pending' ||
          item.telegramStatus === 'pending' ||
          item.telegramStatus === 'sending',
      )
        ? 2000
        : false,
  });
  const outcome = live.data ?? result;
  const chosen = collectors.data?.find((item) => item.id === collectorId);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (mutation.isPending) return;
        setOpen(value);
        if (value) {
          setResult(null);
          setCollectorId('');
          setError('');
          setRequest({ batchId: crypto.randomUUID(), caseIds: [...caseIds] });
        }
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={!caseIds.length}>Bulk assign</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {outcome ? 'Bulk assignment complete' : 'Bulk assign cases'}
          </DialogTitle>
          <DialogDescription>
            {outcome
              ? 'Assignments are saved independently. Telegram delivery continues through the outbound queue.'
              : 'Each case receives its own assignment and Telegram message using the collector’s active chat and topic.'}
          </DialogDescription>
        </DialogHeader>
        {outcome ? (
          <div className="space-y-4">
            <div
              aria-live="polite"
              className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3"
            >
              <p>Assigned: {outcome.summary.assigned}</p>
              <p>Skipped: {outcome.summary.skipped}</p>
              <p>Save failed: {outcome.summary.failed}</p>
              <p>Telegram queued: {outcome.summary.telegramQueued}</p>
              <p>Telegram retrying: {outcome.summary.telegramRetrying}</p>
              <p>Telegram failed: {outcome.summary.telegramFailed}</p>
              <p>Telegram sent: {outcome.summary.telegramSent}</p>
              {!!outcome.summary.processing && (
                <p>Processing: {outcome.summary.processing}</p>
              )}
            </div>
            <p className="break-all text-sm text-muted-foreground">
              Batch: {outcome.batchId}
            </p>
            {live.isError && (
              <p role="alert" className="text-sm text-destructive">
                Delivery status could not be refreshed.
                <Button variant="link" onClick={() => void live.refetch()}>
                  Retry status
                </Button>
              </p>
            )}
            <ul className="space-y-3" aria-label="Per-case assignment results">
              {outcome.items.map((item) => (
                <li key={item.caseId} className="rounded-lg border p-3 text-sm">
                  <p className="break-words font-medium">
                    {item.label
                      ? `${item.label.caseNo} · ${item.label.customerName}`
                      : 'Unavailable case'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge
                      variant={
                        item.status === 'assigned' ? 'secondary' : 'outline'
                      }
                    >
                      {item.status}
                    </Badge>
                    {item.telegramStatus && (
                      <Badge variant="outline">
                        Telegram: {item.telegramStatus}
                      </Badge>
                    )}
                  </div>
                  {item.reason && (
                    <p className="mt-2 text-muted-foreground">
                      {reasons[item.reason] ?? 'Could not process this case'}
                    </p>
                  )}
                  {item.telegramError && (
                    <p className="mt-2 break-words text-muted-foreground">
                      {item.telegramError === 'DELIVERY_UNKNOWN'
                        ? 'Delivery uncertain; reconciliation required before resending.'
                        : `Delivery: ${item.telegramError}`}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!request) return;
              setError('');
              try {
                const output = await mutation.mutateAsync({
                  ...request,
                  collectorId,
                });
                setResult(output);
                onAssigned();
                await refresh();
              } catch (failure: unknown) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : 'Bulk assignment could not be saved. Retry uses the same batch ID.',
                );
              }
            }}
          >
            <p className="text-sm">
              Selected: {request?.caseIds.length ?? caseIds.length} cases
            </p>
            <div className="space-y-2">
              <Label htmlFor="bulk-collector">Collector</Label>
              <select
                id="bulk-collector"
                required
                value={collectorId}
                disabled={mutation.isPending}
                onChange={(event) => setCollectorId(event.target.value)}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">Choose a collector</option>
                {collectors.data?.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={item.routeCount !== 1}
                  >
                    {item.displayName} · {item.code}
                    {item.routeCount !== 1 ? ' — active route required' : ''}
                  </option>
                ))}
              </select>
            </div>
            {chosen && (
              <p className="text-sm">Collector: {chosen.displayName}</p>
            )}
            {collectors.isPending && (
              <output className="text-sm text-muted-foreground">
                Loading collectors…
              </output>
            )}
            {collectors.isError && (
              <p role="alert" className="text-sm text-destructive">
                Collectors could not be loaded.
                <Button
                  type="button"
                  variant="link"
                  onClick={() => void collectors.refetch()}
                >
                  Retry
                </Button>
              </p>
            )}
            {collectors.data &&
              !collectors.data.some((item) => item.routeCount === 1) && (
                <p className="text-sm text-muted-foreground">
                  Configure one active Telegram collector route before
                  assigning.
                </p>
              )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={mutation.isPending || chosen?.routeCount !== 1}
              >
                {mutation.isPending ? 'Assigning…' : 'Confirm assignment'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
