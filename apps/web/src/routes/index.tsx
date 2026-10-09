import { createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '~/components/cases/dashboard';
import { WorkspaceShell } from '~/components/workspace-shell';
export const Route = createFileRoute('/')({ component: Home });
function Home() {
  return (
    <WorkspaceShell>
      <Dashboard />
    </WorkspaceShell>
  );
}
