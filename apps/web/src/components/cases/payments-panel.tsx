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
import { useRef, useState } from 'react';
import { orpc } from '~/lib/orpc';
import { useCasePermissions, useRefreshCases } from './management-hooks';
import { CaseError, LoadingCases, money } from './presentation';

export function PaymentsPanel({ caseId }: { caseId: string }) {
  const permissions = useCasePermissions(),
    refresh = useRefreshCases();
  const [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    key = useRef(crypto.randomUUID());
  const paymentOptions = orpc.finance.payments.queryOptions({
      input: { id: caseId },
    }),
    planOptions = orpc.installments.list.queryOptions({
      input: { id: caseId },
    });
  const payments = useQuery({
      ...paymentOptions,
      queryKey: [permissions.userId, ...paymentOptions.queryKey],
      enabled: permissions.can('payment.view'),
      retry: false,
    }),
    plans = useQuery({
      ...planOptions,
      queryKey: [permissions.userId, ...planOptions.queryKey],
      enabled: permissions.can('installment.view'),
      retry: false,
    });
  const receive = useMutation(orpc.finance.createPayment.mutationOptions()),
    voidPayment = useMutation(orpc.finance.voidPayment.mutationOptions()),
    cancelPlan = useMutation(orpc.installments.cancel.mutationOptions());
  if (!permissions.can('payment.view'))
    return (
      <p className="text-sm text-muted-foreground">
        Payment access is restricted.
      </p>
    );
  return (
    <div className="space-y-6">
      {/* Actual receipts are independent of the forecast schedule. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Record money only after receipt is confirmed.
        </p>
        {permissions.can('payment.create') && (
          <Dialog
            open={open}
            onOpenChange={(value) => {
              if (!receive.isPending) {
                setOpen(value);
                setError('');
                if (value) key.current = crypto.randomUUID();
              }
            }}
          >
            <DialogTrigger asChild>
              <Button>Record payment</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Record received payment</DialogTitle>
                <DialogDescription>
                  This creates an actual receipt and a separate pending return
                  ledger entry.
                </DialogDescription>
              </DialogHeader>
              <form
                className="space-y-4"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  try {
                    await receive.mutateAsync({
                      caseId,
                      idempotencyKey: key.current,
                      receivedDate: String(data.get('date')),
                      receivedAmount: Number(data.get('amount')),
                      installmentScheduleId:
                        String(data.get('schedule') ?? '') || null,
                    });
                    await refresh();
                    setOpen(false);
                  } catch (failure: unknown) {
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : 'Could not record payment.',
                    );
                  }
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="payment-date">Receipt date</Label>
                  <Input
                    id="payment-date"
                    name="date"
                    type="date"
                    required
                    defaultValue={new Intl.DateTimeFormat('en-CA', {
                      timeZone: 'Asia/Taipei',
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                    }).format(new Date())}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="payment-amount">Received amount (TWD)</Label>
                  <Input
                    id="payment-amount"
                    name="amount"
                    type="number"
                    min={1}
                    max={1e12}
                    step={1}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="payment-schedule">Schedule (optional)</Label>
                  <select
                    id="payment-schedule"
                    name="schedule"
                    defaultValue=""
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Independent receipt</option>
                    {plans.data?.schedules
                      .filter(
                        (s) => s.status !== 'paid' && s.status !== 'cancelled',
                      )
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.dueDate} · {money(s.expectedAmount - s.paidAmount)}{' '}
                          remaining
                        </option>
                      ))}
                  </select>
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button type="submit" disabled={receive.isPending}>
                  {receive.isPending ? 'Saving…' : 'Confirm receipt'}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>
      {payments.isPending ? (
        <LoadingCases />
      ) : payments.isError ? (
        <CaseError retry={() => void payments.refetch()} />
      ) : !payments.data.length ? (
        <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
          No payments yet.
        </p>
      ) : (
        <div className="space-y-3">
          {payments.data.map((payment) => (
            <article
              key={payment.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
            >
              <div>
                <p className="text-sm">
                  {payment.receivedDate} · {payment.agentCode} ·{' '}
                  {payment.customerName}
                </p>
                <p className="mt-2 font-medium tabular-nums">
                  {money(payment.receivedAmount)} ·{' '}
                  {payment.status === 'received' ? '已收款' : 'Voided'}
                </p>
              </div>
              {permissions.can('payment.void') &&
                payment.status === 'received' && (
                  <Button
                    variant="outline"
                    disabled={voidPayment.isPending}
                    onClick={async () => {
                      try {
                        await voidPayment.mutateAsync({
                          id: payment.id,
                          expectedVersion: payment.version,
                        });
                        await refresh();
                      } catch (failure: unknown) {
                        setError(
                          failure instanceof Error
                            ? failure.message
                            : 'Could not void payment.',
                        );
                      }
                    }}
                  >
                    Void payment
                  </Button>
                )}
            </article>
          ))}
        </div>
      )}
      {error && !open && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {/* Plans predict expected amounts and never create actual receipts. */}
      {permissions.can('installment.view') && (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Installment plans</h2>
          {plans.isError ? (
            <CaseError retry={() => void plans.refetch()} />
          ) : plans.isPending ? (
            <LoadingCases />
          ) : !plans.data.plans.length ? (
            <p className="text-sm text-muted-foreground">
              No installment plan. Collectors can configure a plan through
              Telegram after selecting installment.
            </p>
          ) : (
            plans.data.plans.map((plan) => (
              <article
                key={plan.id}
                className="space-y-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
              >
                <div className="flex flex-wrap justify-between gap-3">
                  <p className="text-base font-medium">
                    {plan.planType} · {money(plan.totalAmount)} · {plan.status}
                  </p>
                  {plan.status === 'active' &&
                    permissions.can('installment.cancel') && (
                      <Button
                        variant="outline"
                        disabled={cancelPlan.isPending}
                        onClick={async () => {
                          try {
                            await cancelPlan.mutateAsync({
                              id: plan.id,
                              expectedVersion: plan.version,
                            });
                            await refresh();
                          } catch (failure: unknown) {
                            setError(
                              failure instanceof Error
                                ? failure.message
                                : 'Could not cancel plan.',
                            );
                          }
                        }}
                      >
                        Cancel plan
                      </Button>
                    )}
                </div>
                <ol className="space-y-2">
                  {plans.data.schedules
                    .filter((s) => s.planId === plan.id)
                    .map((s) => (
                      <li
                        key={s.id}
                        className="flex flex-wrap justify-between gap-2 text-sm"
                      >
                        <span>
                          {s.sequence}. {s.dueDate}
                        </span>
                        <span className="tabular-nums">
                          Expected {money(s.expectedAmount)} · Received{' '}
                          {money(s.paidAmount)} · {s.status}
                        </span>
                      </li>
                    ))}
                </ol>
              </article>
            ))
          )}
        </section>
      )}
    </div>
  );
}
