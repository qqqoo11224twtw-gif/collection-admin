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
import { Textarea } from '@saasflare-dev/ui/components/textarea';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { orpc } from '~/lib/orpc';
import { useCasePermissions, useRefreshCases } from './management-hooks';
import { CaseError, LoadingCases, timestamp } from './presentation';

export function AssignmentPanel({
  caseId,
  version,
}: {
  caseId: string;
  version: number;
}) {
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const options = orpc.cases.assignments.queryOptions({
    input: { id: caseId },
  });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
  });
  const choicesOptions = orpc.collectors.choices.queryOptions();
  const choices = useQuery({
    ...choicesOptions,
    queryKey: [permissions.userId, ...choicesOptions.queryKey],
    enabled: permissions.can('assignment.create'),
  });
  const mutation = useMutation(orpc.cases.assign.mutationOptions());
  const correction = useMutation(
    orpc.cases.correctAssignment.mutationOptions(),
  );
  const current = result.data?.find((item) => !item.unassignedAt);
  const canAssign = permissions.can(
    current ? 'assignment.reassign' : 'assignment.create',
  );
  return (
    <div className="space-y-5">
      {canAssign && (
        <Dialog
          open={open}
          onOpenChange={(value) => {
            if (!mutation.isPending && !correction.isPending) {
              setOpen(value);
              setError('');
            }
          }}
        >
          <DialogTrigger asChild>
            <Button onClick={() => setCorrecting(false)}>
              {current ? 'Change assignment' : 'Assign case'}
            </Button>
          </DialogTrigger>
          {current && permissions.can('assignment.correct') && (
            <Button
              variant="outline"
              onClick={() => {
                setCorrecting(true);
                setOpen(true);
              }}
            >
              Correct historical collector
            </Button>
          )}
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {correcting
                  ? 'Correct historical collector'
                  : current
                    ? 'Change assignment'
                    : 'Assign case'}
              </DialogTitle>
              <DialogDescription>
                Only active collectors can receive cases. Changes preserve the
                previous assignment.
              </DialogDescription>
            </DialogHeader>
            {open && (
              <form
                className="space-y-4"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setError('');
                  const data = new FormData(event.currentTarget);
                  try {
                    if (correcting)
                      await correction.mutateAsync({
                        caseId,
                        expectedVersion: version,
                        collectorId: String(data.get('collectorId')),
                        reason: String(data.get('note') ?? ''),
                      });
                    else
                      await mutation.mutateAsync({
                        caseId,
                        expectedVersion: version,
                        collectorId: String(data.get('collectorId')) || null,
                        note: String(data.get('note') ?? '').trim() || null,
                      });
                    await refresh();
                    setOpen(false);
                  } catch (failure: unknown) {
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : 'Assignment could not be saved.',
                    );
                  }
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="assignment-collector">Collector</Label>
                  <select
                    id="assignment-collector"
                    name="collectorId"
                    defaultValue={current?.collectorId ?? ''}
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Unassigned</option>
                    {choices.data?.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.displayName} · {item.code}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="assignment-note">
                    {correcting ? 'Correction reason' : 'Note'}
                  </Label>
                  <Textarea
                    id="assignment-note"
                    name="note"
                    maxLength={1000}
                    required={correcting}
                  />
                </div>
                {choices.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    Collectors could not be loaded.
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={
                    mutation.isPending ||
                    correction.isPending ||
                    choices.isPending ||
                    choices.isError
                  }
                >
                  {mutation.isPending || correction.isPending
                    ? 'Saving…'
                    : correcting
                      ? 'Save correction'
                      : 'Save assignment'}
                </Button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      )}
      {result.isPending ? (
        <LoadingCases />
      ) : result.isError ? (
        <CaseError retry={() => void result.refetch()} />
      ) : !result.data.length ? (
        <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
          No assignment history yet.
        </p>
      ) : (
        <ol className="space-y-4">
          {result.data.map((item) => (
            <li
              key={item.id}
              className="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <h3 className="text-base font-medium">
                  {item.displayName}{' '}
                  <span className="text-sm text-muted-foreground">
                    {item.collectorCode}
                  </span>
                </h3>
                <Badge variant="secondary">
                  {item.unassignedAt
                    ? result.data.some(
                        (entry) => entry.correctedFromId === item.id,
                      )
                      ? 'Corrected'
                      : 'Ended'
                    : item.collectorActive
                      ? 'Current'
                      : 'Current · collector inactive'}
                </Badge>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                {item.recordType === 'correction'
                  ? 'Historical correction · Original assignment'
                  : 'Assigned'}{' '}
                {timestamp(item.assignedAt)} · By {item.assignedBy}
              </p>
              {item.unassignedAt && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {result.data.some(
                    (entry) => entry.correctedFromId === item.id,
                  )
                    ? 'Corrected on'
                    : 'Ended'}{' '}
                  {timestamp(item.unassignedAt)}
                </p>
              )}
              {item.note && (
                <p className="mt-3 whitespace-pre-wrap text-sm">{item.note}</p>
              )}
              {item.correctionReason && (
                <p className="mt-3 text-sm">
                  Correction reason: {item.correctionReason}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
