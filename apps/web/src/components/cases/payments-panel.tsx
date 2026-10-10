import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@saasflare-dev/ui/components/dialog';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  displayError,
  displayLabel,
  installmentStatusLabel,
} from '~/components/cases/display-labels';
import { DialogContent } from '~/components/cases/localized-dialog';
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
    voidPayment = useMutation(orpc.finance.voidPayment.mutationOptions());
  if (!permissions.can('payment.view'))
    return (
      <p className="text-sm text-muted-foreground">無收款紀錄查看權限。</p>
    );
  return (
    <div className="space-y-6">
      <p className="font-medium">
        累計實收：
        {money(
          payments.data
            ?.filter((p) => p.status === 'received')
            .reduce((sum, p) => sum + p.receivedAmount, 0) ?? 0,
        )}
      </p>
      {/* Actual receipts are independent of the forecast schedule. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          確認實際收到款項後，再新增收款紀錄。
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
              <Button>新增收款</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>記錄實際收款</DialogTitle>
                <DialogDescription>
                  此操作會建立實際收款及尚未回款紀錄。
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
                      installmentScheduleId: null,
                    });
                    await refresh();
                    setOpen(false);
                  } catch (failure: unknown) {
                    setError(displayError(failure, '無法新增收款紀錄。'));
                  }
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="payment-date">收款日期</Label>
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
                  <Label htmlFor="payment-amount">收款金額（新臺幣）</Label>
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

                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button type="submit" disabled={receive.isPending}>
                  {receive.isPending ? '儲存中…' : '確認收款'}
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
          暫無收款紀錄。
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
                  {payment.status === 'received' ? '已收款' : '已作廢'}
                </p>
              </div>
              {permissions.can('payment.void') &&
                payment.status === 'received' &&
                payment.canVoid && (
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
                        setError(displayError(failure, '無法作廢收款紀錄。'));
                      }
                    }}
                  >
                    作廢收款
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
          <h2 className="text-lg font-medium">歷史分期計畫（唯讀）</h2>
          {plans.isError ? (
            <CaseError retry={() => void plans.refetch()} />
          ) : plans.isPending ? (
            <LoadingCases />
          ) : !plans.data.plans.length ? (
            <p className="text-sm text-muted-foreground">
              暫無歷史分期計畫。新的分期回報只標記案件，不建立期程。
            </p>
          ) : (
            plans.data.plans.map((plan) => (
              <article
                key={plan.id}
                className="space-y-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
              >
                <div className="flex flex-wrap justify-between gap-3">
                  <p className="text-base font-medium">
                    {displayLabel(plan.planType)} · {money(plan.totalAmount)} ·{' '}
                    {displayLabel(plan.status)}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  原定分期總額：{money(plan.totalAmount)} · 已分配至分期：
                  {money(plan.allocatedAmount)} · 剩餘計畫金額：
                  {money(plan.remainingPlannedAmount)} · 剩餘期數：
                  {plan.remainingInstallmentCount}
                </p>
                <p className="text-sm text-muted-foreground">
                  分期是收款計畫，不代表客戶實際欠款；未分配實收：
                  {money(plans.data.unappliedAmount)}
                </p>
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
                          計畫金額 {money(s.expectedAmount)} · 已分配{' '}
                          {money(s.paidAmount)} · 剩餘計畫金額{' '}
                          {money(Math.max(0, s.expectedAmount - s.paidAmount))}{' '}
                          · {installmentStatusLabel(s.status)}
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
