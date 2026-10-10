import { createFileRoute } from '@tanstack/react-router';
import { InstallmentTrackingPage } from '~/components/cases/installment-tracking-page';

export const Route = createFileRoute('/cases/installments')({
  component: InstallmentTrackingPage,
});
