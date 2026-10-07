import type { AppRouterClient } from '@saasflare-dev/api';
import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { Textarea } from '@saasflare-dev/ui/components/textarea';
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
import { reportRevisitLabels } from '~/components/cases/reports-panel';
import { orpc } from '~/lib/orpc';
export const Route = createFileRoute('/cases/reviews/$reviewId')({
  component: ReviewDetail,
});
type Review = Awaited<ReturnType<AppRouterClient['reviews']['detail']>>;
type Confirmed = NonNullable<
  Parameters<AppRouterClient['reviews']['resolve']>[0]['confirmedData']
>;
function ReviewDetail() {
  const { reviewId } = Route.useParams();
  const permissions = useCasePermissions();
  const options = orpc.reviews.detail.queryOptions({ input: { id: reviewId } });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('review.view'),
    retry: false,
  });
  if (permissions.isPending) return <LoadingCases />;
  if (!permissions.can('review.view'))
    return (
      <p className="text-sm text-muted-foreground">
        You do not have access to reviews.
      </p>
    );
  if (result.isPending) return <LoadingCases />;
  if (result.isError) return <CaseError retry={() => void result.refetch()} />;
  return (
    <ReviewForm
      key={`${result.data.id}:${result.data.version}`}
      record={result.data}
    />
  );
}
function ReviewForm({ record }: { record: Review }) {
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const resolve = useMutation(orpc.reviews.resolve.mutationOptions());
  const [error, setError] = useState('');
  const proposal = record.proposedData;
  const pending = record.status === 'pending';
  const editable = pending && permissions.can('review.resolve');
  const classification =
    proposal.type === 'report_classification' ? proposal.classification : null;
  const payment =
    proposal.type === 'payment_detection' ? proposal.payment : classification;
  const canApprove =
    proposal.type !== 'report_classification' ||
    classification?.status !== 'needs_review';
  function confirmedFrom(form: HTMLFormElement): Confirmed {
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '');
    const observation = {
      payment_detected: data.get('payment_detected') === 'on',
      payment_amount:
        data.get('payment_detected') === 'on' && text('payment_amount') !== ''
          ? Number(text('payment_amount'))
          : null,
    };
    switch (proposal.type) {
      case 'case_match':
        return { type: 'case_match', selectedCaseId: text('selectedCaseId') };
      case 'image_extraction':
        return {
          type: 'image_extraction',
          extraction: {
            code: text('code'),
            customer_name: text('customer_name'),
            address: text('address'),
            amount_due: Number(text('amount_due')),
          },
        };
      case 'payment_detection':
        return { type: 'payment_detection', payment: observation };
      case 'report_classification':
        return {
          type: 'report_classification',
          classification: {
            status: text('status') as NonNullable<
              typeof classification
            >['status'],
            revisit_status: (text('revisit_status') || null) as NonNullable<
              typeof classification
            >['revisit_status'],
            revisit_reason: text('revisit_reason') || null,
            ...observation,
            confidence: proposal.classification.confidence,
          },
        };
    }
  }
  return (
    <div className="space-y-6">
      <Link
        to="/cases/reviews"
        search={{ page: 1, query: '', status: 'pending', type: '' }}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Review center
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Confirm findings
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{record.reason}</p>
        </div>
        <Badge variant="secondary">{record.status}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {record.source} · Confidence:{' '}
        {record.confidence === null
          ? 'Not supplied'
          : `${Math.round(record.confidence * 100)}%`}{' '}
        · {timestamp(record.createdAt)}
      </p>
      {record.currentCase && (
        <Link
          to="/cases/$caseId"
          params={{ caseId: record.currentCase.id }}
          className="block break-all text-sm font-medium hover:underline"
        >
          {record.currentCase.customerName} · {record.currentCase.caseNo}
        </Link>
      )}
      {/* The original proposal remains visible after the final confirmation is saved. */}
      <section className="rounded-xl bg-muted/50 p-5 space-y-3">
        <h2 className="text-lg font-medium">Original proposal</h2>
        {'originalContent' in proposal && (
          <p className="whitespace-pre-wrap break-words text-sm">
            {proposal.originalContent}
          </p>
        )}
        {proposal.type === 'image_extraction' ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            {Object.entries(proposal.extraction).map(([key, value]) => (
              <div key={key}>
                <dt className="text-sm text-muted-foreground">
                  {key.replaceAll('_', ' ')}
                </dt>
                <dd className="mt-1 break-words text-sm">{String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : proposal.type === 'report_classification' ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            {Object.entries(proposal.classification).map(([key, value]) => (
              <div key={key}>
                <dt className="text-sm text-muted-foreground">
                  {key.replaceAll('_', ' ')}
                </dt>
                <dd className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {value === null
                    ? 'Not supplied'
                    : typeof value === 'boolean'
                      ? value
                        ? 'Yes'
                        : 'No'
                      : String(value)}
                </dd>
              </div>
            ))}
          </dl>
        ) : proposal.type === 'payment_detection' ? (
          <p className="text-sm">
            {proposal.payment.payment_detected
              ? 'Payment detected'
              : 'No payment detected'}{' '}
            · {proposal.payment.payment_amount ?? 'Amount not supplied'}
          </p>
        ) : (
          <p className="text-sm">Lookup: {proposal.query.value}</p>
        )}
      </section>
      {!pending && (
        <section className="rounded-xl bg-card p-5 ring-1 ring-foreground/10 space-y-3">
          <h2 className="text-lg font-medium">Final confirmation</h2>
          <p className="text-sm text-muted-foreground">
            Resolved {record.resolvedAt ? timestamp(record.resolvedAt) : '—'} ·{' '}
            {record.resolvedByName ?? 'Former user'}
          </p>
          {record.confirmedData ? (
            <dl className="grid gap-3 sm:grid-cols-2">
              {Object.entries(
                record.confirmedData.type === 'report_classification'
                  ? record.confirmedData.classification
                  : record.confirmedData.type === 'image_extraction'
                    ? record.confirmedData.extraction
                    : record.confirmedData.type === 'payment_detection'
                      ? record.confirmedData.payment
                      : { selected_case: record.confirmedData.selectedCaseId },
              ).map(([key, value]) => (
                <div key={key}>
                  <dt className="text-sm text-muted-foreground">
                    {key.replaceAll('_', ' ')}
                  </dt>
                  <dd className="mt-1 break-words text-sm">
                    {value === null ? 'Not supplied' : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm">Rejected. Case data was not changed.</p>
          )}
        </section>
      )}
      {pending && (
        <form
          className="rounded-xl bg-card p-5 ring-1 ring-foreground/10 space-y-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setError('');
            const decision = (
              event.nativeEvent as SubmitEvent
            ).submitter?.getAttribute('value') as
              | 'approved'
              | 'corrected'
              | 'rejected';
            try {
              await resolve.mutateAsync({
                id: record.id,
                decision,
                expectedCaseVersion: record.currentCase?.version,
                confirmedData:
                  decision === 'corrected' ||
                  (decision === 'approved' && proposal.type === 'case_match')
                    ? confirmedFrom(event.currentTarget)
                    : undefined,
              });
              await refresh();
            } catch (failure: unknown) {
              setError(
                failure instanceof Error
                  ? failure.message
                  : 'Unable to resolve review.',
              );
            }
          }}
        >
          <h2 className="text-lg font-medium">Review and confirm</h2>
          <fieldset
            disabled={!editable || resolve.isPending}
            className="space-y-4"
          >
            {proposal.type === 'case_match' ? (
              <div className="space-y-2">
                <Label htmlFor="review-candidate">Candidate case</Label>
                <select
                  id="review-candidate"
                  name="selectedCaseId"
                  defaultValue=""
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="">Choose a candidate</option>
                  {record.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.customerName} · {c.code} · {c.caseNo}
                    </option>
                  ))}
                </select>
              </div>
            ) : proposal.type === 'image_extraction' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {Object.entries(proposal.extraction).map(([name, value]) => (
                  <div key={name} className="space-y-2">
                    <Label htmlFor={`extraction-${name}`}>
                      {name.replaceAll('_', ' ')}
                    </Label>
                    <Input
                      id={`extraction-${name}`}
                      name={name}
                      type={name === 'amount_due' ? 'number' : 'text'}
                      min={name === 'amount_due' ? 0 : undefined}
                      step={name === 'amount_due' ? 1 : undefined}
                      defaultValue={value}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {classification && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="confirm-status">Confirmed status</Label>
                        <select
                          id="confirm-status"
                          name="status"
                          defaultValue={classification.status}
                          className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                        >
                          <option value="needs_review">
                            Choose a final status
                          </option>
                          {[
                            'cannot_find',
                            'follow_up',
                            'installment',
                            'settled',
                            'unresolved',
                          ].map((s) => (
                            <option key={s} value={s}>
                              {s.replaceAll('_', ' ')}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="confirm-revisit">
                          Revisit recommendation
                        </Label>
                        <select
                          id="confirm-revisit"
                          name="revisit_status"
                          defaultValue={classification.revisit_status ?? ''}
                          className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                        >
                          <option value="">Keep current recommendation</option>
                          {Object.entries(reportRevisitLabels).map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="confirm-reason">Revisit reason</Label>
                      <Textarea
                        id="confirm-reason"
                        name="revisit_reason"
                        maxLength={2000}
                        defaultValue={classification.revisit_reason ?? ''}
                      />
                    </div>
                  </>
                )}
                <Label className="flex items-center gap-2">
                  <input
                    name="payment_detected"
                    type="checkbox"
                    defaultChecked={payment?.payment_detected}
                  />
                  Payment detected
                </Label>
                <div className="space-y-2">
                  <Label htmlFor="confirm-payment">
                    Reported payment amount (TWD)
                  </Label>
                  <Input
                    id="confirm-payment"
                    name="payment_amount"
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={payment?.payment_amount ?? ''}
                  />
                </div>
              </>
            )}
            <p className="text-sm text-muted-foreground">
              Approve uses the original proposal. Choose corrected approval to
              save edited values.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                name="decision"
                value="approved"
                disabled={!canApprove}
              >
                Approve proposal
              </Button>
              <Button
                type="submit"
                name="decision"
                value="corrected"
                variant="outline"
              >
                Approve corrected values
              </Button>
              <Button
                type="submit"
                name="decision"
                value="rejected"
                variant="outline"
                formNoValidate
              >
                Reject
              </Button>
            </div>
          </fieldset>
          {!editable && (
            <p className="text-sm text-muted-foreground">
              You do not have permission to resolve this review.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
