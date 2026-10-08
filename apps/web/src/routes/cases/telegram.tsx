import type { AppRouterClient } from '@saasflare-dev/api';
import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { CaseError, LoadingCases } from '~/components/cases/presentation';
import { orpc } from '~/lib/orpc';
export const Route = createFileRoute('/cases/telegram')({
  component: TelegramSettings,
});
type RouteRecord = Awaited<
  ReturnType<AppRouterClient['telegram']['routes']>
>[number];
type Identity = Awaited<
  ReturnType<AppRouterClient['telegram']['identities']>
>[number];
function TelegramSettings() {
  const permissions = useCasePermissions();
  const allowed = permissions.can('telegram_route.manage');
  const cache = useQueryClient();
  const scoped = <T,>(options: T & { queryKey: readonly unknown[] }) => ({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: allowed,
  });
  const routes = useQuery(scoped(orpc.telegram.routes.queryOptions()));
  const identities = useQuery(scoped(orpc.telegram.identities.queryOptions()));
  const options = useQuery(scoped(orpc.telegram.options.queryOptions()));
  const jobs = useQuery(scoped(orpc.telegram.jobs.queryOptions()));
  const saveRoute = useMutation(orpc.telegram.saveRoute.mutationOptions());
  const saveIdentity = useMutation(
    orpc.telegram.saveIdentity.mutationOptions(),
  );
  const process = useMutation(orpc.telegram.process.mutationOptions());
  const [editingRoute, setEditingRoute] = useState<RouteRecord | null>(null);
  const [editingIdentity, setEditingIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState('');
  const refresh = () =>
    cache.invalidateQueries({
      predicate: (query) => query.queryKey[0] === permissions.userId,
    });
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : 'Could not save settings.');
  const busy =
    saveRoute.isPending || saveIdentity.isPending || process.isPending;
  if (permissions.isPending) return <LoadingCases />;
  if (!allowed)
    return (
      <div className="rounded-xl border p-5">
        <h1 className="font-semibold">Access denied</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Telegram management permission is required.
        </p>
      </div>
    );
  if (routes.isPending || identities.isPending || options.isPending)
    return <LoadingCases />;
  if (routes.isError || identities.isError || options.isError)
    return (
      <CaseError
        retry={() => {
          void refresh();
        }}
      />
    );
  return (
    <div className="space-y-6">
      {/* Administrative integration context. */}
      <div>
        <h1 className="text-xl font-semibold">Telegram settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Authorized routes and collector identities. Mode: {options.data.mode}.
          Credentials stay on the server.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Route and identity editors. */}
        <section className="space-y-4 rounded-xl border bg-card p-5">
          <h2 className="font-semibold">
            {editingRoute ? 'Edit route' : 'New route'}
          </h2>
          <form
            key={editingRoute?.id ?? 'new-route'}
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              const f = new FormData(e.currentTarget);
              try {
                await saveRoute.mutateAsync({
                  id: editingRoute?.id,
                  chatId: String(f.get('chatId')),
                  topicId: f.get('topicId') ? Number(f.get('topicId')) : null,
                  routeType: String(
                    f.get('routeType'),
                  ) as RouteRecord['routeType'],
                  collectorId: String(f.get('collectorId')) || null,
                  isActive: f.get('active') === 'on',
                });
                setEditingRoute(null);
                await refresh();
              } catch (e: unknown) {
                fail(e);
              }
            }}
          >
            <Field
              label="Chat ID"
              name="chatId"
              required
              defaultValue={editingRoute?.chatId}
            />
            <Field
              label="Topic ID (optional)"
              name="topicId"
              type="number"
              defaultValue={editingRoute?.topicId ?? ''}
            />
            <Label className="block space-y-2">
              Route purpose
              <select
                name="routeType"
                defaultValue={editingRoute?.routeType ?? 'intake_source'}
                className="h-9 w-full rounded-lg border bg-background px-3"
              >
                <option value="intake_source">Intake source</option>
                <option value="collector">Collector</option>
                <option value="report_destination">Business reports</option>
              </select>
            </Label>
            <Label className="block space-y-2">
              Collector
              <select
                name="collectorId"
                defaultValue={editingRoute?.collectorId ?? ''}
                className="h-9 w-full rounded-lg border bg-background px-3"
              >
                <option value="">No collector</option>
                {options.data.collectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="active"
                defaultChecked={editingRoute?.isActive ?? true}
              />
              Active route
            </Label>
            <div className="flex gap-2">
              <Button disabled={busy}>Save route</Button>
              {editingRoute && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingRoute(null)}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </section>
        <section className="space-y-4 rounded-xl border bg-card p-5">
          <h2 className="font-semibold">
            {editingIdentity ? 'Edit identity' : 'Bind identity'}
          </h2>
          <form
            key={editingIdentity?.id ?? 'new-identity'}
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              const f = new FormData(e.currentTarget);
              try {
                await saveIdentity.mutateAsync({
                  id: editingIdentity?.id,
                  telegramUserId: String(f.get('telegramUserId')),
                  displayName: String(f.get('displayName')) || null,
                  collectorId: String(f.get('collectorId')) || null,
                  userId: String(f.get('userId')) || null,
                  isActive: f.get('active') === 'on',
                });
                setEditingIdentity(null);
                await refresh();
              } catch (e: unknown) {
                fail(e);
              }
            }}
          >
            <Field
              label="Telegram user ID"
              name="telegramUserId"
              required
              defaultValue={editingIdentity?.telegramUserId}
            />
            <Field
              label="Display name (optional)"
              name="displayName"
              defaultValue={editingIdentity?.displayName ?? ''}
            />
            <Label className="block space-y-2">
              Linked collector
              <select
                name="collectorId"
                defaultValue={editingIdentity?.collectorId ?? ''}
                className="h-9 w-full rounded-lg border bg-background px-3"
              >
                <option value="">Unbound</option>
                {options.data.collectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="block space-y-2">
              Linked login (optional)
              <select
                name="userId"
                defaultValue={editingIdentity?.userId ?? ''}
                className="h-9 w-full rounded-lg border bg-background px-3"
              >
                <option value="">Use collector login</option>
                {options.data.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.email}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="active"
                defaultChecked={editingIdentity?.isActive ?? true}
              />
              Active identity
            </Label>
            <div className="flex gap-2">
              <Button disabled={busy}>Save identity</Button>
              {editingIdentity && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingIdentity(null)}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </section>
      </div>
      <section className="space-y-3">
        <h2 className="font-semibold">Routes</h2>
        {!routes.data.length && (
          <p className="text-sm text-muted-foreground">No routes configured.</p>
        )}
        {routes.data.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          >
            <div className="min-w-0 break-all text-sm">
              {r.routeType} · {r.chatId}
              {r.topicId ? ` / Topic ${r.topicId}` : ''}{' '}
              <Badge variant="secondary">
                {r.isActive ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingRoute(r)}
            >
              Edit route
            </Button>
          </div>
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Identities</h2>
        {!identities.data.length && (
          <p className="text-sm text-muted-foreground">No identities bound.</p>
        )}
        {identities.data.map((i) => (
          <div
            key={i.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          >
            <div className="text-sm">
              {i.displayName ?? 'Collector'} · {i.telegramUserId}{' '}
              <Badge variant="secondary">
                {i.isActive ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingIdentity(i)}
            >
              Edit identity
            </Button>
          </div>
        ))}
      </section>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Delivery jobs</h2>
          {options.data.mode === 'fake' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                try {
                  await process.mutateAsync({});
                  await refresh();
                } catch (e: unknown) {
                  fail(e);
                }
              }}
            >
              Process local jobs
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Delivery unknown requires manual reconciliation; automatic resend is
          blocked.
        </p>
        {jobs.isError ? (
          <p role="alert">Jobs unavailable.</p>
        ) : (
          jobs.data?.map((j) => (
            <div
              key={j.id}
              className="flex flex-wrap gap-3 rounded-xl border p-4 text-sm"
            >
              <span>{j.messageType}</span>
              <Badge variant="secondary">{j.status}</Badge>
              <span>{j.attempts} attempts</span>
              {j.lastErrorCode && <span>{j.lastErrorCode}</span>}
            </div>
          ))
        )}
        {jobs.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No delivery jobs.</p>
        )}
      </section>
    </div>
  );
}
function Field(props: {
  label: string;
  name: string;
  required?: boolean;
  type?: string;
  defaultValue?: string | number;
}) {
  return (
    <Label className="block space-y-2">
      {props.label}
      <Input
        name={props.name}
        required={props.required}
        type={props.type ?? 'text'}
        defaultValue={props.defaultValue}
      />
    </Label>
  );
}
