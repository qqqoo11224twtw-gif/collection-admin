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
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useCasePermissions,
  useRefreshCases,
} from '~/components/cases/management-hooks';
import {
  CaseError,
  LoadingCases,
  timestamp,
} from '~/components/cases/presentation';
import { orpc } from '~/lib/orpc';

const statuses = [
  'received',
  'processing',
  'needs_review',
  'matched',
  'created',
  'rejected',
  'failed',
] as const;
const sources = [
  'manual',
  'telegram',
  'line',
  'poster_builder',
  'historical_import',
  'api',
] as const;
export const Route = createFileRoute('/cases/intake/')({
  validateSearch: (s: Record<string, unknown>) => ({
    page: Math.max(1, Math.min(100000, Math.floor(Number(s.page) || 1))),
    query: typeof s.query === 'string' ? s.query.slice(0, 120) : '',
    status: statuses.includes(s.status as (typeof statuses)[number])
      ? String(s.status)
      : '',
    source: sources.includes(s.source as (typeof sources)[number])
      ? String(s.source)
      : '',
  }),
  component: IntakeList,
});
function NewIntake() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const receive = useMutation(orpc.intake.receive.mutationOptions());
  const refresh = useRefreshCases();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New intake</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Receive draft</DialogTitle>
          <DialogDescription>
            This saves a draft. No case will be created until confirmation.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            const data = new FormData(e.currentTarget);
            const text = (key: string) => String(data.get(key) ?? '').trim();
            try {
              await receive.mutateAsync({
                source: 'manual',
                externalId: null,
                dedupeKey: null,
                caseNo: null,
                confidence: null,
                proposedData: {
                  code: text('code') || null,
                  customer_name: text('customer_name') || null,
                  address: text('address') || null,
                  amount_due: text('amount_due')
                    ? Number(text('amount_due'))
                    : null,
                },
              });
              await refresh();
              setOpen(false);
            } catch (f: unknown) {
              setError(
                f instanceof Error ? f.message : 'Unable to receive draft.',
              );
            }
          }}
        >
          {[
            ['customer_name', 'Customer name'],
            ['code', 'Code'],
            ['address', 'Address'],
            ['amount_due', 'Amount due (TWD)'],
          ].map(([name, label]) => (
            <div key={name} className="space-y-2">
              <Label htmlFor={`draft-${name}`}>{label}</Label>
              <Input
                id={`draft-${name}`}
                name={name}
                type={name === 'amount_due' ? 'number' : 'text'}
                min={name === 'amount_due' ? 0 : undefined}
                step={name === 'amount_due' ? 1 : undefined}
              />
            </div>
          ))}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button disabled={receive.isPending}>Save draft</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function IntakeList() {
  const permissions = useCasePermissions();
  const search = Route.useSearch();
  const nav = Route.useNavigate();
  const options = orpc.intake.list.queryOptions({
    input: {
      page: search.page,
      pageSize: 10,
      query: search.query,
      status: search.status
        ? (search.status as (typeof statuses)[number])
        : undefined,
      source: search.source
        ? (search.source as (typeof sources)[number])
        : undefined,
    },
  });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('intake.view'),
  });
  if (permissions.isPending) return <LoadingCases />;
  if (!permissions.can('intake.view'))
    return (
      <p className="text-sm text-muted-foreground">
        You do not have access to intakes.
      </p>
    );
  const update = (values: Partial<typeof search>) =>
    void nav({ search: { ...search, ...values, page: 1 } });
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Intake inbox</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Incoming drafts stay separate from confirmed case records.
          </p>
        </div>
        {permissions.can('intake.create') && <NewIntake />}
      </div>
      {/* Lightweight intake filters, without financial summaries. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="intake-search">Search intakes</Label>
          <Input
            id="intake-search"
            value={search.query}
            onChange={(e) => update({ query: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="intake-status">Intake status</Label>
          <select
            id="intake-status"
            value={search.status}
            onChange={(e) => update({ status: e.target.value })}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="intake-source">Intake source</Label>
          <select
            id="intake-source"
            value={search.source}
            onChange={(e) => update({ source: e.target.value })}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll('_', ' ')}
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
              No intakes match these filters.
            </p>
          ) : (
            <ul className="space-y-4">
              {result.data.items.map((row) => (
                <li
                  key={row.id}
                  className="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
                >
                  <div className="flex flex-wrap justify-between gap-3">
                    <Link
                      to="/cases/intake/$intakeId"
                      params={{ intakeId: row.id }}
                      className="text-base font-medium hover:underline"
                    >
                      {row.customerName ?? 'Incomplete draft'}
                    </Link>
                    <Badge variant="secondary">
                      {row.status.replaceAll('_', ' ')}
                    </Badge>
                  </div>
                  <p className="mt-3 text-sm">
                    {row.code ?? 'Code not supplied'} ·{' '}
                    {row.source.replaceAll('_', ' ')} ·{' '}
                    {timestamp(row.createdAt)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
                    <span>{row.mediaCount} images</span>
                    {row.reviewItemId && <span>Human review required</span>}
                    {row.matchedCaseId && (
                      <Link
                        to="/cases/$caseId"
                        params={{ caseId: row.matchedCaseId }}
                        className="hover:underline"
                      >
                        Matched case
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {result.data.total} intakes · Page {search.page}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={search.page === 1}
                onClick={() =>
                  void nav({ search: { ...search, page: search.page - 1 } })
                }
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={search.page * 10 >= result.data.total}
                onClick={() =>
                  void nav({ search: { ...search, page: search.page + 1 } })
                }
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
