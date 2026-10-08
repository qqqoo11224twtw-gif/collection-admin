import { createFileRoute, Outlet } from '@tanstack/react-router';
export const Route = createFileRoute('/cases/intake')({
  component: () => <Outlet />,
});
