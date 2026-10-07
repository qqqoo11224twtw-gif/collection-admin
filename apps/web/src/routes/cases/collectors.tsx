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
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useCasePermissions,
  useRefreshCases,
} from '~/components/cases/management-hooks';
import { CaseError, LoadingCases } from '~/components/cases/presentation';
import { orpc } from '~/lib/orpc';

export const Route = createFileRoute('/cases/collectors')({
  component: CollectorsPage,
});
type Collector = Awaited<
  ReturnType<AppRouterClient['collectors']['list']>
>[number];
function CollectorEditor({ record }: { record?: Collector }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const options = orpc.collectors.users.queryOptions();
  const users = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: open,
  });
  const create = useMutation(orpc.collectors.create.mutationOptions());
  const edit = useMutation(orpc.collectors.edit.mutationOptions());
  const busy = create.isPending || edit.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={record ? 'outline' : 'default'}
          size={record ? 'sm' : 'default'}
        >
          {record ? 'Edit collector' : 'New collector'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {record ? 'Edit collector' : 'New collector'}
          </DialogTitle>
          <DialogDescription>
            Link a login account to grant access to assigned cases. No Telegram
            identifiers are stored.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setError('');
              const data = new FormData(event.currentTarget);
              const fields = {
                displayName: String(data.get('displayName')),
                code: String(data.get('code')),
                userId: String(data.get('userId') ?? '') || null,
                isActive: record?.isActive ?? true,
              };
              try {
                if (record)
                  await edit.mutateAsync({
                    ...fields,
                    id: record.id,
                    expectedVersion: record.version,
                  });
                else await create.mutateAsync(fields);
                await refresh();
                setOpen(false);
              } catch (failure: unknown) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : 'Collector could not be saved.',
                );
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="collector-name">Display name</Label>
              <Input
                id="collector-name"
                name="displayName"
                required
                maxLength={120}
                defaultValue={record?.displayName}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="collector-code">Collector code</Label>
              <Input
                id="collector-code"
                name="code"
                required
                maxLength={60}
                defaultValue={record?.code}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="collector-user">Linked login</Label>
              <select
                id="collector-user"
                name="userId"
                defaultValue={record?.userId ?? ''}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">No login linked</option>
                {users.data?.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.email}
                  </option>
                ))}
              </select>
              <p className="text-sm text-muted-foreground">
                A login link cannot change while assignments are current.
              </p>
            </div>
            {users.isError && (
              <p role="alert" className="text-sm text-destructive">
                Login accounts could not be loaded.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={busy || users.isPending || users.isError}
            >
              {busy ? 'Saving…' : 'Save collector'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
function CollectorsPage() {
  const permissions = useCasePermissions();
  const refresh = useRefreshCases();
  const [error, setError] = useState('');
  const options = orpc.collectors.list.queryOptions();
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('collector.manage'),
  });
  const toggle = useMutation(orpc.collectors.edit.mutationOptions());
  if (permissions.isPending) return <LoadingCases />;
  if (!permissions.can('collector.manage'))
    return (
      <p role="alert" className="text-sm text-destructive">
        You do not have permission to manage collectors.
      </p>
    );
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Collectors</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Manage the people responsible for field collection.
          </p>
        </div>
        <CollectorEditor />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result.isPending ? (
        <LoadingCases />
      ) : result.isError ? (
        <CaseError retry={() => void result.refetch()} />
      ) : !result.data.length ? (
        <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
          No collectors yet. Add your first collector.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {result.data.map((record) => (
            <article
              key={record.id}
              className="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
            >
              <div className="flex justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium">{record.displayName}</h2>
                  <p className="mt-2 text-sm font-mono text-muted-foreground">
                    {record.code}
                  </p>
                </div>
                <Badge variant="secondary">
                  {record.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <p className="mt-4 text-sm text-muted-foreground">
                {record.userId ? 'Login account linked' : 'No login linked'}
              </p>
              <div className="mt-4 flex gap-2">
                <CollectorEditor record={record} />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={toggle.isPending}
                  onClick={async () => {
                    setError('');
                    try {
                      await toggle.mutateAsync({
                        id: record.id,
                        expectedVersion: record.version,
                        displayName: record.displayName,
                        code: record.code,
                        userId: record.userId,
                        isActive: !record.isActive,
                      });
                      await refresh();
                    } catch (failure: unknown) {
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : 'Unable to change collector status.',
                      );
                    }
                  }}
                >
                  {record.isActive ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
