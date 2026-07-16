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
import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@saasflare-dev/ui/components/dialog';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { cn } from '@saasflare-dev/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { orpc } from '~/lib/orpc';

type ApiKeyRow = {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  createdAt: string | Date;
  expiresAt: string | Date | null;
};

function formatDate(value: string | Date | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function keyStatus(key: ApiKeyRow): {
  label: string;
  variant: 'default' | 'secondary' | 'destructive';
} {
  if (!key.enabled) return { label: 'Disabled', variant: 'destructive' };
  if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now()) {
    return { label: 'Expired', variant: 'destructive' };
  }
  return { label: 'Active', variant: 'secondary' };
}

/**
 * Self-contained API key management: heading + create button, key table with
 * revoke, and the create dialog (plaintext shown once).
 */
export function ApiKeysManager() {
  const keysQuery = useQuery(orpc.apiKeys.list.queryOptions());
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound size={15} /> API keys
          </h3>
          <p className="text-xs text-muted-foreground">
            Bearer tokens for the external API (try{' '}
            <code className="rounded bg-muted px-1">GET /api/v1/whoami</code>).
            The plaintext is shown once at creation.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <Plus size={16} /> Create key
        </Button>
      </div>

      {keysQuery.isLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Loading keys…
        </p>
      ) : keysQuery.isError ? (
        <p className="py-8 text-center text-sm text-red-600">
          {keysQuery.error.message}
        </p>
      ) : (keysQuery.data ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No API keys yet. Create one to call the API from outside the app.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Key</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 font-medium">Expires</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {(keysQuery.data ?? []).map((key) => (
                <KeyRow key={key.id} row={key} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateKeyDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function KeyRow({ row }: { row: ApiKeyRow }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const status = keyStatus(row);

  const revokeMutation = useMutation(
    orpc.apiKeys.revoke.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() }),
    }),
  );

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="px-4 py-2.5 font-medium">{row.name ?? '—'}</td>
      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
        {row.start ? `${row.start}…` : '(hidden)'}
      </td>
      <td className="px-4 py-2.5 text-muted-foreground">
        {formatDate(row.createdAt)}
      </td>
      <td className="px-4 py-2.5 text-muted-foreground">
        {formatDate(row.expiresAt)}
      </td>
      <td className="px-4 py-2.5">
        <Badge variant={status.variant}>{status.label}</Badge>
      </td>
      <td className="px-4 py-2.5 text-right">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-red-600 hover:text-red-700"
          onClick={() => setConfirming(true)}
          disabled={revokeMutation.isPending}
        >
          Revoke
        </Button>
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Revoke “{row.name ?? row.id}”?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Requests using this key stop working immediately. This cannot be
                undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 text-white hover:bg-red-700"
                onClick={() => revokeMutation.mutate({ keyId: row.id })}
              >
                Revoke key
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </td>
    </tr>
  );
}

/**
 * Create flow. The plaintext key lives ONLY in this component's state and is
 * dropped when the dialog closes — never in the URL, localStorage, or the
 * query cache (mutation state is reset on close).
 */
// null = never expires (the default); numbers are days.
const EXPIRY_PRESETS: Array<number | null> = [null, 7, 30, 90, 365];

function expiryLabel(days: number | null): string {
  if (days === null) return 'Never expires';
  if (days === 365) return '1 year';
  return `${days} days`;
}

function CreateKeyDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const createMutation = useMutation(
    orpc.apiKeys.create.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() }),
    }),
  );
  const created = createMutation.data ?? null;

  const create = () => {
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      ...(expiresInDays ? { expiresInDays } : {}),
    });
  };

  const close = () => {
    // Drop the plaintext from memory along with the dialog.
    createMutation.reset();
    setName('');
    setExpiresInDays(null);
    setCopied(false);
    onClose();
  };

  const copyKey = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.key);
    setCopied(true);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>
                Copy it now — this is the only time the full key is shown.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <code
                data-testid="created-key"
                className="break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
              >
                {created.key}
              </code>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={() => void copyKey()}>
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={close}
                >
                  Done
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                Name the key after its caller so it's easy to revoke later.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. ci-pipeline"
                  maxLength={64}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') create();
                  }}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Expiry</Label>
                <div className="flex flex-wrap gap-2">
                  {EXPIRY_PRESETS.map((days) => (
                    <button
                      type="button"
                      key={days ?? 'never'}
                      onClick={() => setExpiresInDays(days)}
                      className={cn(
                        'text-xs font-medium px-3 py-1.5 rounded-full border transition-colors',
                        expiresInDays === days
                          ? 'bg-foreground text-background border-transparent'
                          : 'bg-card text-muted-foreground border-border hover:bg-muted',
                      )}
                    >
                      {expiryLabel(days)}
                    </button>
                  ))}
                </div>
              </div>
              {createMutation.isError ? (
                <p className="text-sm text-red-600">
                  {createMutation.error.message}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={close}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!name.trim() || createMutation.isPending}
                  onClick={create}
                >
                  {createMutation.isPending ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : null}
                  Create
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
