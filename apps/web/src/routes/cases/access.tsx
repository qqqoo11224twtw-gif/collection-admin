import { createFileRoute } from '@tanstack/react-router';
import { AccessEmailsPage } from '~/components/access-emails';
export const Route = createFileRoute('/cases/access')({
  component: AccessEmailsPage,
});
