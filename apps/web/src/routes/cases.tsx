import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { AuthGate } from '~/components/auth-gate';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { UserMenu } from '~/components/user-menu';

export const Route = createFileRoute('/cases')({ component: CaseWorkspace });
function CaseWorkspace() {
  const permissions = useCasePermissions();
  return (
    <AuthGate>
      <main className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-8 md:px-8">
        {/* Workspace navigation and explicit demo-data context. */}
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Link
            to="/"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Starter console
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            {permissions.can('collector.manage') && (
              <Link
                to="/cases/collectors"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Collectors
              </Link>
            )}
            <UserMenu />
          </div>
        </div>
        <div className="rounded-lg bg-info/5 px-4 py-3 text-sm text-muted-foreground">
          Local demo workspace · All cases and images are fictional. No live
          integrations.
        </div>
        <Outlet />
      </main>
    </AuthGate>
  );
}
