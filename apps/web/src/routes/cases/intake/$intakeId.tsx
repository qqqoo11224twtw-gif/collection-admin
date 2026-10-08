import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
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
export const Route = createFileRoute('/cases/intake/$intakeId')({
  component: IntakeDetail,
});
function Thumbnail({
  intakeId,
  id,
  name,
}: {
  intakeId: string;
  id: string;
  name: string;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    void fetch(
      `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/intake/${intakeId}/media/${id}/image`,
      { credentials: 'include', signal: controller.signal },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const blob = await r.blob();
        if (!controller.signal.aborted) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [intakeId, id]);
  return url ? (
    <img
      src={url}
      alt={name}
      className="aspect-video w-full rounded-lg bg-muted object-contain"
    />
  ) : (
    <p className="rounded-lg bg-muted p-8 text-sm text-muted-foreground">
      {error ? 'Image unavailable' : 'Loading image…'}
    </p>
  );
}
const actions = {
  'intake.received': 'Intake received',
  'intake.duplicate_detected': 'Duplicate detected',
  'intake.processing': 'Matching completed',
  'intake.sent_to_review': 'Sent to human review',
  'intake.created_case': 'Case created',
  'intake.matched': 'Case matched',
  'intake.rejected': 'Intake rejected',
  'intake.media_uploaded': 'Images received',
  'media.promoted': 'Images promoted',
} as Record<string, string>;
function IntakeDetail() {
  const { intakeId } = Route.useParams();
  const permissions = useCasePermissions();
  const options = orpc.intake.detail.queryOptions({ input: { id: intakeId } });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('intake.view'),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.extractionJobs.length &&
      (query.state.data.status === 'received' ||
        query.state.data.extractionJobs.some(
          (job) => job.status === 'pending' || job.status === 'processing',
        ))
        ? 1000
        : false,
  });
  const resolve = useMutation(orpc.intake.resolve.mutationOptions());
  const process = useMutation(orpc.intake.process.mutationOptions());
  const extract = useMutation(orpc.intake.extractImages.mutationOptions());
  const refresh = useRefreshCases();
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  if (permissions.isPending) return <LoadingCases />;
  if (!permissions.can('intake.view'))
    return (
      <p className="text-sm text-muted-foreground">
        You do not have access to intakes.
      </p>
    );
  if (result.isPending) return <LoadingCases />;
  if (result.isError) return <CaseError retry={() => void result.refetch()} />;
  const row = result.data;
  const terminal = ['created', 'matched', 'rejected'].includes(row.status);
  const aiPending = row.extractionJobs.some(
    (job) => job.status === 'pending' || job.status === 'processing',
  );
  const busy =
    resolve.isPending ||
    process.isPending ||
    uploading ||
    aiPending ||
    extract.isPending;
  async function action(
    value: 'create' | 'match' | 'review' | 'reject',
    caseId?: string,
  ) {
    setError('');
    try {
      await resolve.mutateAsync({
        id: intakeId,
        expectedVersion: row.version,
        action: value,
        caseId,
      });
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unable to process intake.');
    }
  }
  return (
    <div className="space-y-6">
      <Link
        to="/cases/intake"
        search={{ page: 1, query: '', status: '', source: '' }}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Intake inbox
      </Link>
      <div className="flex flex-wrap justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {row.proposedData.customer_name ?? 'Incomplete draft'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {row.source.replaceAll('_', ' ')} · {timestamp(row.createdAt)}
          </p>
        </div>
        <Badge variant="secondary">{row.status.replaceAll('_', ' ')}</Badge>
      </div>
      {/* Proposed and confirmed records remain distinct. */}
      <section className="rounded-xl border bg-card p-5 space-y-3">
        <h2 className="text-lg font-medium">Image extraction</h2>
        <p className="text-sm text-muted-foreground">
          Confidence:{' '}
          {row.confidence === null
            ? 'Not supplied'
            : `${Math.round(row.confidence * 100)}%`}{' '}
          ·{' '}
          {row.review?.status === 'pending'
            ? 'Human confirmation required'
            : aiPending
              ? 'Processing images'
              : 'Results are validated before case resolution'}
        </p>
        {row.extractionJobs.map((job) => (
          <p key={job.id} className="text-sm text-muted-foreground">
            {job.provider} · {job.model} · {job.status}
            {job.errorCode && ` · ${job.errorCode}`}
          </p>
        ))}
        {!terminal &&
          row.status !== 'needs_review' &&
          row.media.length > 0 &&
          permissions.can('intake.resolve') && (
            <Button
              variant="outline"
              disabled={busy || extract.isPending || aiPending}
              onClick={async () => {
                try {
                  await extract.mutateAsync({ id: intakeId });
                  await refresh();
                } catch (e: unknown) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : 'Extraction could not be queued.',
                  );
                }
              }}
            >
              Extract image fields
            </Button>
          )}
      </section>
      <div className="grid gap-5 md:grid-cols-2">
        {[
          ['Original proposal', row.proposedData],
          ['Confirmed data', row.confirmedData],
        ].map(([title, data]) => (
          <section
            key={String(title)}
            className="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
          >
            <h2 className="text-lg font-medium">{String(title)}</h2>
            {data && typeof data === 'object' ? (
              <dl className="mt-4 grid gap-4">
                {Object.entries(data).map(([key, value]) => (
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
              <p className="mt-4 text-sm text-muted-foreground">
                Not confirmed yet.
              </p>
            )}
          </section>
        ))}
      </div>
      <section className="rounded-xl bg-muted/50 p-5 space-y-4">
        <h2 className="text-lg font-medium">Case matching</h2>
        <p className="text-sm">
          {row.matching.kind.replaceAll('_', ' ')} ·{' '}
          {row.matching.method.replaceAll('_', ' ')}
        </p>
        {row.matchedCase && (
          <Link
            to="/cases/$caseId"
            params={{ caseId: row.matchedCase.id }}
            className="block break-all text-sm font-medium hover:underline"
          >
            {row.matchedCase.customerName} · {row.matchedCase.caseNo}
          </Link>
        )}
        {row.review && (
          <Link
            to="/cases/reviews/$reviewId"
            params={{ reviewId: row.review.id }}
            className="block text-sm font-medium hover:underline"
          >
            Human review · {row.review.status}
          </Link>
        )}
        {!terminal && permissions.can('intake.resolve') && (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={busy || row.status === 'needs_review'}
              onClick={async () => {
                setError('');
                try {
                  await process.mutateAsync({
                    id: intakeId,
                    expectedVersion: row.version,
                  });
                  await refresh();
                } catch (e: unknown) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : 'Unable to analyze intake.',
                  );
                }
              }}
            >
              Analyze draft
            </Button>
            {row.matching.kind === 'no_match' && (
              <Button
                disabled={busy || row.status === 'needs_review'}
                onClick={() => void action('create')}
              >
                Create new case
              </Button>
            )}
            {row.matching.kind === 'unique_match' && (
              <Button
                disabled={busy || row.status === 'needs_review'}
                onClick={() =>
                  void action('match', row.matching.candidates[0]?.id)
                }
              >
                Match existing case
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy || row.status === 'needs_review'}
              onClick={() => void action('review')}
            >
              Send to review
            </Button>
          </div>
        )}
        {!terminal && permissions.can('intake.reject') && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void action('reject')}
          >
            Reject intake
          </Button>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Private attachments</h2>
        {!terminal && permissions.can('intake.create') && (
          <form
            className="space-y-3 rounded-xl bg-muted/50 p-5"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              setUploading(true);
              const form = e.currentTarget;
              const data = new FormData(form);
              data.set('expectedVersion', String(row.version));
              try {
                const response = await fetch(
                  `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/intake/${intakeId}/media`,
                  { method: 'POST', credentials: 'include', body: data },
                );
                if (!response.ok)
                  throw new Error(
                    'Images could not be saved. Refresh and check file types and size.',
                  );
                form.reset();
                await refresh();
              } catch (e: unknown) {
                setError(e instanceof Error ? e.message : 'Upload failed.');
              } finally {
                setUploading(false);
              }
            }}
          >
            <Label htmlFor="intake-files">
              PNG, JPEG or WebP · up to 5 images, 5 MiB each
            </Label>
            <Input
              id="intake-files"
              name="files"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              required
            />
            <Button disabled={busy}>Upload images</Button>
          </form>
        )}
        {!row.media.length && (
          <p className="text-sm text-muted-foreground">No attachments yet.</p>
        )}
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {row.media.map((m) => (
            <li
              key={m.id}
              className="rounded-xl bg-card p-4 ring-1 ring-foreground/10"
            >
              <Thumbnail
                intakeId={intakeId}
                id={m.id}
                name={m.originalFilename}
              />
              <p className="mt-3 break-all text-sm font-medium">
                {m.originalFilename}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Order {m.sortOrder} · {timestamp(m.createdAt)}
              </p>
              {m.isDuplicate && (
                <Badge variant="outline" className="mt-2">
                  Duplicate hash
                </Badge>
              )}
              {m.promotedAt && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Promoted to case
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Intake activity</h2>
        <ol className="space-y-3">
          {row.audit.map((item) => (
            <li
              key={item.id}
              className="rounded-xl bg-card p-4 ring-1 ring-foreground/10"
            >
              <p className="text-sm font-medium">
                {actions[item.action] ?? item.action}
              </p>
              <p className="mt-2 break-words text-sm text-muted-foreground">
                {item.actor ?? 'System'} · {timestamp(item.createdAt)}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
