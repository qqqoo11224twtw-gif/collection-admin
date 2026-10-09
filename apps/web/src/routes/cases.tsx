import { createFileRoute, Outlet } from '@tanstack/react-router';
import { WorkspaceShell } from '~/components/workspace-shell';
export const Route = createFileRoute('/cases')({ component: CaseWorkspace });
function CaseWorkspace() {
  return (
    <WorkspaceShell>
      <Outlet />
    </WorkspaceShell>
  );
}
