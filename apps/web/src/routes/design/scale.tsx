import { Badge } from '@saasflare-dev/ui/components/badge';
import { cn } from '@saasflare-dev/ui/lib/utils';
import { createFileRoute } from '@tanstack/react-router';
import { formatAmount, PAYMENTS } from '~/components/design/fixtures';

export const Route = createFileRoute('/design/scale')({
  component: ScalePage,
});

/**
 * Which utility each role in a screen uses. Nothing here changes a token —
 * both columns render with the stock Tailwind scale. The only variable is
 * *which steps get picked*, which is the actual lever: the scale is a palette
 * to choose from, not a ladder to walk one rung at a time.
 *
 * Class names are written out in full because Tailwind scans source text
 * statically and would emit nothing for an interpolated class.
 */
interface Spec {
  name: string;
  summary: string;
  steps: string;
  ratios: string;
  pageTitle: string;
  sectionTitle: string;
  cardTitle: string;
  cardValue: string;
  body: string;
  meta: string;
}

const ADJACENT: Spec = {
  name: 'Adjacent steps',
  summary:
    'What the codebase does today. Section titles, card titles and table text all land on the same 14px step, so hierarchy is carried entirely by weight, caps and color — size contributes nothing.',
  steps: '12 · 14 · 16 · 24',
  ratios: '1.17 → 1.14 → 1.50',
  pageTitle: 'text-2xl font-bold tracking-tight',
  sectionTitle: 'text-sm font-semibold uppercase tracking-wider',
  cardTitle: 'text-sm font-medium',
  cardValue: 'text-base font-semibold tabular-nums',
  body: 'text-sm',
  meta: 'text-xs',
};

const SKIPPED: Spec = {
  name: 'Skipped steps',
  summary:
    'Same scale, every other step. 12px is dropped entirely — secondary text stays at 14px and recedes through color instead of shrinking. Section titles move up to 18px so a glance can find them without reading.',
  steps: '14 · 18 · 24',
  ratios: '1.29 → 1.33',
  pageTitle: 'text-2xl font-semibold tracking-tight',
  sectionTitle: 'text-lg font-medium tracking-tight',
  cardTitle: 'text-sm font-medium',
  cardValue: 'text-xl font-semibold tabular-nums',
  body: 'text-sm',
  meta: 'text-sm',
};

const ROWS = PAYMENTS.slice(0, 4);

/** One screen fragment, rendered identically apart from the type steps. */
function Specimen({ spec }: { spec: Spec }) {
  return (
    <div className="flex flex-col gap-6 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h3 className={cn(spec.pageTitle, 'text-foreground')}>Payments</h3>
        <p className={cn(spec.meta, 'text-muted-foreground')}>
          Every charge across all connected methods.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <h4 className={cn(spec.sectionTitle, 'text-foreground')}>This month</h4>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Volume', value: '24,318.00' },
            { label: 'Refunded', value: '445.00' },
          ].map((stat) => (
            <div
              key={stat.label}
              className="flex flex-col gap-1 rounded-md border border-border p-3"
            >
              <span className={cn(spec.cardTitle, 'text-muted-foreground')}>
                {stat.label}
              </span>
              <span className={cn(spec.cardValue, 'text-foreground')}>
                {stat.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h4 className={cn(spec.sectionTitle, 'text-foreground')}>
          Recent activity
        </h4>
        <div className="flex flex-col">
          {ROWS.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-0"
            >
              <div className="flex min-w-0 flex-col">
                <span className={cn(spec.body, 'truncate font-medium')}>
                  {p.customer}
                </span>
                <span className={cn(spec.meta, 'text-muted-foreground')}>
                  {p.createdAt} · {p.method}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className={cn(spec.body, 'tabular-nums font-mono')}>
                  {formatAmount(p.amountCents)}
                </span>
                <Badge variant="secondary" className={spec.meta}>
                  {p.status}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Column({ spec }: { spec: Spec }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold tracking-tight">{spec.name}</h2>
          <code className="text-xs text-muted-foreground">{spec.steps}</code>
        </div>
        <p className="text-sm text-muted-foreground">{spec.summary}</p>
        <p className="text-xs text-muted-foreground">
          Step ratios:{' '}
          <span className="font-mono text-foreground">{spec.ratios}</span>
        </p>
      </div>
      <Specimen spec={spec} />
    </div>
  );
}

function ScalePage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2 max-w-3xl">
        <p className="text-sm text-muted-foreground">
          Both columns use the stock Tailwind type scale — no token is modified.
          The only difference is which steps each role picks. Tailwind ships a
          palette to choose from, not a ladder to climb one rung at a time, and
          picking adjacent rungs is what flattens the hierarchy.
        </p>
        <p className="text-sm text-muted-foreground">
          A useful reference: shadcn's own typography examples run 16 → 20 → 24
          → 30 → 36, every step at least 1.2x the last. Dashboards drift the
          other way, bunching at 12–16px, because the instinct is to fit more
          in.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Column spec={ADJACENT} />
        <Column spec={SKIPPED} />
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-4 flex flex-col gap-2">
        <h2 className="text-sm font-semibold">What to look for</h2>
        <ul className="text-sm text-muted-foreground flex flex-col gap-1.5 list-disc pl-4">
          <li>
            Can you find "This month" and "Recent activity" without reading
            them? On the left they are the same size as the data beneath.
          </li>
          <li>
            Does the 12px timestamp on the left read comfortably in Chinese?
            That step is the first thing to break in dense CJK text.
          </li>
          <li>
            The right column is not bigger overall — the page title and table
            rows are identical. Only the middle of the hierarchy moved.
          </li>
        </ul>
      </div>
    </div>
  );
}
