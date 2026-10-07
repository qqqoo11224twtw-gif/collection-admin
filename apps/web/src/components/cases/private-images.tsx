import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@saasflare-dev/ui/components/alert-dialog';
import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { Skeleton } from '@saasflare-dev/ui/components/skeleton';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSession } from '~/lib/auth';
import { orpc } from '~/lib/orpc';
import { useCasePermissions, useRefreshCases } from './management-hooks';
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
export function PrivateImages({
  caseId,
  version,
}: {
  caseId: string;
  version: number;
}) {
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = useMutation(orpc.cases.deleteMedia.mutationOptions());
  const reorder = useMutation(orpc.cases.reorderMedia.mutationOptions());
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
  return (
    <div className="space-y-5">
      {/* All bytes go through the authenticated API, never through a public upload URL. */}
      {permissions.can('media.upload') && (
        <form
          className="space-y-3 rounded-xl bg-muted/40 p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setMessage('');
            const formElement = event.currentTarget;
            const form = new FormData(formElement);
            const files = form.getAll('files');
            if (
              !files.length ||
              files.length > 5 ||
              files.some(
                (file) =>
                  typeof file === 'string' ||
                  !file.size ||
                  file.size > 5 * 1024 * 1024,
              )
            ) {
              setMessage('Choose one to five images, at most 5 MiB each.');
              return;
            }
            form.set('expectedVersion', String(version));
            setUploading(true);
            try {
              const response = await fetch(
                `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/cases/${encodeURIComponent(caseId)}/media`,
                { method: 'POST', body: form, credentials: 'include' },
              );
              if (!response.ok) {
                const error = (await response.json()) as { message?: string };
                throw new Error(
                  error.message ?? 'Upload failed. Refresh and try again.',
                );
              }
              formElement.reset();
              await refresh();
            } catch (failure: unknown) {
              setMessage(
                failure instanceof Error ? failure.message : 'Upload failed.',
              );
            } finally {
              setUploading(false);
            }
          }}
        >
          <Label htmlFor="case-upload">Upload private images</Label>
          <Input
            id="case-upload"
            name="files"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            required
            disabled={uploading || remove.isPending || reorder.isPending}
          />
          <p className="text-sm text-muted-foreground">
            PNG, JPEG or WebP · Up to 5 images per upload · 5 MiB per image
          </p>
          <Button
            type="submit"
            disabled={uploading || remove.isPending || reorder.isPending}
          >
            {uploading ? 'Uploading…' : 'Upload images'}
          </Button>
        </form>
      )}
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      {!result.data.length ? (
        <div className="rounded-xl bg-muted/50 p-12 text-center text-sm text-muted-foreground">
          No images attached to this case.
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {result.data.map((media, index) => (
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
                <div className="flex flex-wrap gap-2">
                  {permissions.can('media.upload') &&
                    [-1, 1].map((direction) => (
                      <Button
                        key={direction}
                        variant="outline"
                        size="sm"
                        aria-label={`${direction < 0 ? 'Move up' : 'Move down'} ${media.originalFilename}`}
                        disabled={
                          uploading ||
                          remove.isPending ||
                          reorder.isPending ||
                          index + direction < 0 ||
                          index + direction >= result.data.length
                        }
                        onClick={async () => {
                          setMessage('');
                          const ids = result.data.map((item) => item.id);
                          [ids[index], ids[index + direction]] = [
                            ids[index + direction],
                            ids[index],
                          ];
                          try {
                            await reorder.mutateAsync({
                              caseId,
                              ids,
                              expectedVersion: version,
                            });
                            await refresh();
                          } catch (failure: unknown) {
                            setMessage(
                              failure instanceof Error
                                ? failure.message
                                : 'Unable to reorder images.',
                            );
                          }
                        }}
                      >
                        {direction < 0 ? '↑ Up' : '↓ Down'}
                      </Button>
                    ))}
                  {permissions.can('media.delete') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={
                        uploading || remove.isPending || reorder.isPending
                      }
                      onClick={() => setDeleting(media.id)}
                    >
                      Delete image
                    </Button>
                  )}
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this image?</AlertDialogTitle>
            <AlertDialogDescription>
              The image will be removed from this case. This action is recorded
              in the activity log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={async (event) => {
                event.preventDefault();
                if (!deleting) return;
                setMessage('');
                try {
                  const result = await remove.mutateAsync({
                    caseId,
                    mediaId: deleting,
                    expectedVersion: version,
                  });
                  await refresh();
                  setDeleting(null);
                  if (result.cleanupPending)
                    setMessage(
                      'Image access was removed. Storage cleanup is pending.',
                    );
                } catch (failure: unknown) {
                  setMessage(
                    failure instanceof Error
                      ? failure.message
                      : 'Unable to delete image.',
                  );
                }
              }}
            >
              Confirm delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
