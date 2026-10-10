import { createFileRoute } from '@tanstack/react-router';
import { FinanceWorkspace } from '~/components/cases/finance-workspace';
export const Route = createFileRoute('/cases/finance')({
  component: FinanceWorkspace,
});
