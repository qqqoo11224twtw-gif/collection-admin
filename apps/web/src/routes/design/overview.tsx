import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@saasflare-dev/ui/components/card';
import { cn } from '@saasflare-dev/ui/lib/utils';
import { createFileRoute } from '@tanstack/react-router';
import {
  ArrowUpRight,
  CreditCard,
  Download,
  LayoutGrid,
  Settings,
  Users,
  Wallet,
} from 'lucide-react';
import {
  formatAmount,
  PAYMENTS,
  type PaymentStatus,
  STATUS_LABEL,
} from '~/components/design/fixtures';

export const Route = createFileRoute('/design/overview')({
  component: OverviewPage,
});

/*
 * A full dashboard assembled from the same tokens as everything else, because
 * a pattern gallery cannot answer "does this look good" — density does. The
 * page deliberately ships no new value: type comes from the four steps, status
 * colors from the semantic tokens, the bars from --chart-1.
 *
 * The sidebar is rendered statically rather than with the Sidebar component,
 * which needs a SidebarProvider owning the viewport; nesting that inside the
 * /design layout would fight it for height. Collapse behaviour is not what
 * this page is testing.
 */

const NAV = [
  { label: 'Overview', Icon: LayoutGrid, active: true },
  { label: 'Payments', Icon: CreditCard, active: false },
  { label: 'Customers', Icon: Users, active: false },
  { label: 'Payouts', Icon: Wallet, active: false },
  { label: 'Settings', Icon: Settings, active: false },
] as const;

const METRICS = [
  { label: 'Gross volume', value: '24,318.00', delta: '+12.4%', up: true },
  { label: 'Net revenue', value: '21,904.20', delta: '+9.1%', up: true },
  { label: 'Refunded', value: '445.00', delta: '−2.3%', up: false },
  { label: 'Failed', value: '765.50', delta: '+0.8%', up: false },
] as const;

/** Twelve months of relative volume, 0–1. Shape only — no real data. */
const TREND = [
  0.42, 0.51, 0.38, 0.63, 0.58, 0.71, 0.66, 0.82, 0.74, 0.91, 0.85, 1,
] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const STATUS_STYLE: Record<PaymentStatus, string> = {
  succeeded: 'bg-success/10 text-success',
  pending: 'bg-warning/10 text-warning',
  failed: 'bg-destructive/10 text-destructive',
  refunded: 'bg-info/10 text-info',
};

function OverviewPage() {
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        The same tokens as every other page, applied at real density. Nothing
        here is new: four type steps, the semantic status colors, and{' '}
        <code className="font-mono">--chart-1</code> for the bars. A pattern
        gallery shows that the parts are correct; only a filled page shows
        whether they add up.
      </p>

      {/* Framed like an app window so the dashboard reads as a product screen
          rather than as more documentation. */}
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex min-h-[560px]">
          <aside className="hidden w-52 shrink-0 flex-col gap-1 border-border border-r bg-sidebar p-3 sm:flex">
            <div className="flex items-center gap-2 px-2 pt-1 pb-4">
              <div className="flex size-6 items-center justify-center rounded bg-foreground text-background">
                <Wallet className="size-3.5" />
              </div>
              <span className="font-medium text-sm">Acme Pay</span>
            </div>

            {NAV.map(({ label, Icon, active }) => (
              <span
                key={label}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm',
                  active
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : 'text-muted-foreground',
                )}
              >
                <Icon className="size-4" />
                {label}
              </span>
            ))}
          </aside>

          <main className="flex min-w-0 flex-1 flex-col gap-6 p-6">
            {/* Page header: title, one primary action, one secondary */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h2 className="font-semibold text-2xl tracking-tight">
                  Overview
                </h2>
                <p className="text-muted-foreground text-sm">
                  Last 30 days · updated 2 minutes ago
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm">
                  <Download />
                  Export
                </Button>
                <Button size="sm">Create payment</Button>
              </div>
            </div>

            {/* Metrics: the one place the type budget gets spent */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {METRICS.map((m) => (
                <Card key={m.label}>
                  <CardHeader>
                    <CardDescription>{m.label}</CardDescription>
                    <CardTitle className="font-semibold text-2xl tabular-nums">
                      {m.value}
                    </CardTitle>
                  </CardHeader>
                  <CardFooter>
                    <span
                      className={cn(
                        'flex items-center gap-1',
                        m.up ? 'text-success' : 'text-muted-foreground',
                      )}
                    >
                      <ArrowUpRight
                        className={cn('size-3.5', !m.up && 'rotate-90')}
                      />
                      {m.delta} vs last month
                    </span>
                  </CardFooter>
                </Card>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
              {/* Chart: plain CSS bars. A charting library is a product
                  decision, not something to smuggle in via a design page. */}
              <Card>
                <CardHeader>
                  <CardTitle>Monthly volume</CardTitle>
                  <CardDescription>2026</CardDescription>
                </CardHeader>
                <CardContent>
                  {/* Bars and labels are separate rows: a percentage height only
                    resolves against a parent with a definite height, so the
                    bars need their own flex-1 track with nothing else in it. */}
                  <div className="flex h-40 flex-col gap-1.5">
                    <div className="flex flex-1 items-end gap-1.5">
                      {TREND.map((v, i) => (
                        <div
                          key={MONTHS[i]}
                          className="flex-1 rounded-t-sm bg-chart-1"
                          style={{ height: `${v * 100}%` }}
                        />
                      ))}
                    </div>
                    <div className="flex gap-1.5">
                      {MONTHS.map((m) => (
                        <span
                          key={m}
                          className="flex-1 text-center text-muted-foreground text-sm"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Recent activity: a list, not a table — five rows with two
                  fields each do not need column headers. */}
              <Card>
                <CardHeader>
                  <CardTitle>Recent payments</CardTitle>
                  <CardAction>
                    <Button variant="link" size="sm" className="h-auto p-0">
                      View all
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col">
                  {PAYMENTS.slice(0, 5).map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-3 border-border border-b py-2.5 last:border-0"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium text-sm">
                          {p.customer}
                        </span>
                        <span className="text-muted-foreground text-sm">
                          {p.method}
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="font-mono text-sm tabular-nums">
                          {formatAmount(p.amountCents)}
                        </span>
                        <Badge className={STATUS_STYLE[p.status]}>
                          {STATUS_LABEL[p.status]}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
