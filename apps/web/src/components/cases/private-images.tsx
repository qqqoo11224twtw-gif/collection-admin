import { Button } from '@saasflare-dev/ui/components/button';
import { Skeleton } from '@saasflare-dev/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSession } from '~/lib/auth';
import { orpc } from '~/lib/orpc';
import { CaseError, timestamp } from './presentation';

function PrivateThumbnail({
  caseId,
  mediaId,
  filename,
}: {
  caseId: string;
  mediaId: string;
  filename: string;
}) {
  const [image, setImage] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setImage(undefined);
    setError(false);
    async function load() {
      try {
        const response = await fetch(
          `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/cases/${encodeURIComponent(caseId)}/media/${encodeURIComponent(mediaId)}/image`,
          {
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('Image unavailable');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setImage(url);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    }
    void load();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [caseId, mediaId, attempt]);
  if (error)
    return (
      <div
        role="alert"
        className="flex aspect-video flex-col items-center justify-center gap-3 bg-muted"
      >
        <p className="text-sm text-destructive">Image unavailable</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry image
        </Button>
      </div>
    );
  return image ? (
    <img
      src={image}
      alt={filename}
      className="aspect-video w-full object-contain bg-muted"
    />
  ) : (
    <Skeleton aria-label="Loading image" className="aspect-video w-full" />
  );
}
export function PrivateImages({ caseId }: { caseId: string }) {
  const { data: session } = useSession();
  const options = orpc.cases.media.queryOptions({ input: { id: caseId } });
  const result = useQuery({
    ...options,
    queryKey: [session?.user.id, ...options.queryKey],
    enabled: !!session,
    retry: false,
  });
  if (result.isPending)
    return <Skeleton className="h-64 w-full" aria-label="Loading media" />;
  if (result.isError) return <CaseError retry={() => void result.refetch()} />;
  if (!result.data.length)
    return (
      <div className="rounded-xl bg-muted/50 p-12 text-center text-sm text-muted-foreground">
        No images attached to this case.
      </div>
    );
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {result.data.map((media) => (
        <figure
          key={media.id}
          className="overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10"
        >
          <PrivateThumbnail
            key={`${session?.user.id}-${media.id}`}
            caseId={caseId}
            mediaId={media.id}
            filename={media.originalFilename}
          />
          <figcaption className="space-y-2 p-4">
            <p className="break-all text-sm font-medium">
              {media.originalFilename}
            </p>
            <p className="text-sm text-muted-foreground">
              Order {media.sortOrder} · {timestamp(media.createdAt)}
            </p>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
