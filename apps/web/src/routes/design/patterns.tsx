import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@saasflare-dev/ui/components/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@saasflare-dev/ui/components/table';
import { cn } from '@saasflare-dev/ui/lib/utils';
import { createFileRoute } from '@tanstack/react-router';
import { Receipt, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  formatAmount,
  PAYMENTS,
  type PaymentStatus,
  STATUS_LABEL,
} from '~/components/design/fixtures';

export const Route = createFileRoute('/design/patterns')({
  component: PatternsPage,
});

/** Frames one pattern with the rule for when NOT to reach for it. */
function Pattern({
  title,
  rationale,
  avoid,
  children,
}: {
  title: string;
  rationale: string;
  avoid: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground max-w-2xl">{rationale}</p>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        {children}
      </div>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Don't use it when:</span>{' '}
        {avoid}
      </p>
    </section>
  );
}

const STATUS_STYLE: Record<PaymentStatus, string> = {
  succeeded: 'bg-secondary text-secondary-foreground',
  pending: 'bg-secondary text-secondary-foreground',
  failed: 'bg-destructive/10 text-destructive',
  refunded: 'bg-secondary text-secondary-foreground',
};

function PaymentsTable() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>ID</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Method</TableHead>
          {/* Numeric column: right-aligned so magnitudes line up */}
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          {/* Action column: fixed narrow, never grows with content */}
          <TableHead className="w-px" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {PAYMENTS.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {p.createdAt}
            </TableCell>
            <TableCell className="font-mono">{p.id}</TableCell>
            <TableCell className="font-medium">{p.customer}</TableCell>
            <TableCell className="text-muted-foreground">{p.method}</TableCell>
            <TableCell
              className={cn(
                // Tabular figures keep digits in vertical columns; without
                // this, proportional digits make totals look ragged.
                'text-right font-mono tabular-nums whitespace-nowrap',
                p.amountCents < 0 && 'text-muted-foreground',
              )}
            >
              {formatAmount(p.amountCents)}
            </TableCell>
            <TableCell>
              <Badge className={STATUS_STYLE[p.status]}>
                {STATUS_LABEL[p.status]}
              </Badge>
            </TableCell>
            <TableCell className="text-right">
              <Button variant="ghost" size="sm">
                View
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const METRICS = [
  { label: 'Gross volume', value: '24,318.00', note: 'across 412 payments' },
  { label: 'Refunded', value: '445.00', note: '2 refunds' },
  { label: 'Failed', value: '765.50', note: '1 declined card' },
] as const;

function PatternsPage() {
  return (
    <div className="flex flex-col gap-12">
      <Pattern
        title="Metric cards"
        rationale="The one place a dashboard should spend its type budget. The number jumps straight from 14px to 24px — no intermediate step — so the eye lands on the figure before reading the label above it. The label stays at body size and recedes through color, and the note underneath explains what the number is made of."
        avoid="the figure needs context to mean anything on its own — a number that is only meaningful as a trend belongs in a chart, where the shape carries the message."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {METRICS.map((m) => (
            <div
              key={m.label}
              className="flex flex-col gap-1 rounded-lg border border-border p-4"
            >
              <span className="text-sm text-muted-foreground">{m.label}</span>
              <span className="text-2xl font-semibold tabular-nums">
                {m.value}
              </span>
              <span className="text-sm text-muted-foreground">{m.note}</span>
            </div>
          ))}
        </div>
      </Pattern>

      <Pattern
        title="Data table"
        rationale="The densest surface in any dashboard, and the one that exposes type-scale problems first. Dates and secondary fields recede to muted-foreground, the identifier is monospace, and the amount column is right-aligned with tabular figures so digits stack. The action column is fixed-width so it never widens with content."
        avoid="the rows have fewer than three fields, or every row needs a different set of actions — a card list reads better and is far easier to make responsive."
      >
        <PaymentsTable />
      </Pattern>

      <Pattern
        title="Empty state"
        rationale="An empty table is the first thing a new user sees, so it should teach rather than apologise: name what belongs here, say how to create the first one, put the action in reach. Never ship a bare 'No data'. Note that the type stays at 18/14 in both sizes below — what changes is the padding. The component's default p-12 is sized for an empty page; inside a card it leaves the content stranded in whitespace and reads as 'small text' when the real problem is proportion."
        avoid="the emptiness is temporary — while loading, show a skeleton of the eventual layout instead, so the page does not jump."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              In a card or panel — <code className="font-mono">p-6</code>
            </span>
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Receipt />
                </EmptyMedia>
                <EmptyTitle>No payments yet</EmptyTitle>
                <EmptyDescription>
                  Payments appear here once your first charge succeeds.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm">Create a test payment</Button>
              </EmptyContent>
            </Empty>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              As a whole page — default <code className="font-mono">p-12</code>
            </span>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Receipt />
                </EmptyMedia>
                <EmptyTitle>No payments yet</EmptyTitle>
                <EmptyDescription>
                  Payments appear here once your first charge succeeds. Test
                  mode charges show up immediately.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm">Create a test payment</Button>
              </EmptyContent>
            </Empty>
          </div>
        </div>
      </Pattern>

      <Pattern
        title="Danger zone"
        rationale="Irreversible actions live in one clearly-marked block at the bottom of a settings page, never inline next to routine controls. Each row states the consequence in plain words; the button label names the action rather than saying 'Confirm'."
        avoid="the action is reversible or trivially repeatable — putting ordinary actions here trains people to ignore the warning styling, which is the only thing protecting the real ones."
      >
        <div className="rounded-lg border border-destructive/30">
          <div className="border-b border-destructive/20 px-4 py-3">
            <h3 className="text-sm font-medium text-foreground">Danger zone</h3>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Delete this workspace</span>
              <span className="text-sm text-muted-foreground">
                Removes all payments, members and API keys. This cannot be
                undone.
              </span>
            </div>
            <Button variant="destructive" size="sm" className="shrink-0">
              <Trash2 />
              Delete workspace
            </Button>
          </div>
        </div>
      </Pattern>
    </div>
  );
}
