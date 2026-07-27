import { Badge } from '@saasflare-dev/ui/components/badge';
import { cn } from '@saasflare-dev/ui/lib/utils';
import { createFileRoute } from '@tanstack/react-router';
import { formatAmount, PAYMENTS } from '~/components/design/fixtures';

export const Route = createFileRoute('/design/scale')({
  component: ScalePage,
});

/**
 * Three ways to assign type steps to the same screen. No token is modified —
 * every column renders with the stock Tailwind scale, and the only variable is
 * which step each role picks. The scale is a palette to choose from, not a
 * ladder to climb one rung at a time.
 *
 * Class names are written out in full because Tailwind scans source text
 * statically and would emit nothing for an interpolated class.
 */
interface Spec {
  name: string;
  summary: string;
  steps: string;
  ratios: string;
  /** Section headings are dropped entirely in the shadcn-style column. */
  sectionTitles: boolean;
  /** Wider gaps have to carry the grouping when headings are gone. */
  groupGap: string;
  pageTitle: string;
  sectionTitle: string;
  cardTitle: string;
  cardValue: string;
  body: string;
  meta: string;
}

const CURRENT: Spec = {
  name: 'A · Current',
  summary:
    'What the codebase does today. Section headings, card labels and table text all land on 14px, so size carries none of the hierarchy — caps, weight and color do all the work. Timestamps drop to 12px.',
  steps: '12 · 14 · 16 · 24',
  ratios: '1.17 → 1.14 → 1.50',
  sectionTitles: true,
  groupGap: 'gap-6',
  pageTitle: 'text-2xl font-bold tracking-tight',
  sectionTitle: 'text-sm font-semibold uppercase tracking-wider',
  cardTitle: 'text-sm font-medium',
  cardValue: 'text-base font-semibold tabular-nums',
  body: 'text-sm',
  meta: 'text-xs',
};

const LIFTED: Spec = {
  name: 'B · Lifted headings',
  summary:
    'Keeps the headings but moves them up to 18px so a glance can find them. 12px is dropped — secondary text stays at 14px and recedes through color instead of shrinking.',
  steps: '14 · 18 · 24',
  ratios: '1.29 → 1.33',
  sectionTitles: true,
  groupGap: 'gap-6',
  pageTitle: 'text-2xl font-semibold tracking-tight',
  sectionTitle: 'text-lg font-medium tracking-tight',
  cardTitle: 'text-sm font-medium',
  cardValue: 'text-xl font-semibold tabular-nums',
  body: 'text-sm',
  meta: 'text-sm',
};

const SHADCN: Spec = {
  name: "C · shadcn's own",
  summary:
    'How dashboard-01 actually does it: no section headings at all — grouping comes from whitespace — and only two steps in play. The metric jumps straight from 14px to 24px, and the block uses text-xs zero times.',
  steps: '14 · 24',
  ratios: '1.71',
  sectionTitles: false,
  groupGap: 'gap-8',
  pageTitle: 'text-2xl font-semibold tracking-tight',
  sectionTitle: '',
  cardTitle: 'text-sm font-normal',
  cardValue: 'text-2xl font-semibold tabular-nums',
  body: 'text-sm',
  meta: 'text-sm',
};

const ROWS = PAYMENTS.slice(0, 4);

/** One screen fragment, identical apart from the type steps it picks. */
function Specimen({ spec }: { spec: Spec }) {
  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border border-border bg-card p-5',
        spec.groupGap,
      )}
    >
      <div className="flex flex-col gap-1">
        <h3 className={cn(spec.pageTitle, 'text-foreground')}>Payments</h3>
        <p className={cn(spec.meta, 'text-muted-foreground')}>
          Every charge across all connected methods.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {spec.sectionTitles && (
          <h4 className={cn(spec.sectionTitle, 'text-foreground')}>
            This month
          </h4>
        )}
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
        {spec.sectionTitles && (
          <h4 className={cn(spec.sectionTitle, 'text-foreground')}>
            Recent activity
          </h4>
        )}
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
                  {p.createdAt}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={cn(spec.body, 'font-mono tabular-nums')}>
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
      <div className="flex max-w-3xl flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          All three columns use the stock Tailwind scale — no token is modified.
          Only the assignment differs. The page title and table rows are the
          same in every column, so nothing here is simply "bigger"; what moves
          is the middle of the hierarchy.
        </p>
        <p className="text-sm text-muted-foreground">
          Column C mirrors shadcn's dashboard-01 block, whose entire type census
          is: text-sm ×8, text-2xl ×4, text-3xl ×4 (the same metric, enlarged by
          container query once the card exceeds 250px), text-base ×1 — and
          text-xs never.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Column spec={CURRENT} />
        <Column spec={LIFTED} />
        <Column spec={SHADCN} />
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-4">
        <h2 className="text-sm font-semibold">What to compare</h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
          <li>
            <span className="text-foreground">Finding your place:</span> in A,
            can you locate the two groups without reading? In C there is no
            label at all — does the whitespace alone make the grouping obvious?
          </li>
          <li>
            <span className="text-foreground">Where the eye lands first:</span>{' '}
            A pulls toward the headings, C pulls toward the numbers. Which is
            right depends on whether people come here to navigate or to read a
            figure.
          </li>
          <li>
            <span className="text-foreground">Cost:</span> C spends its budget
            on one big number and buys grouping with whitespace, so it needs
            more vertical room per block than A.
          </li>
          <li>
            <span className="text-foreground">CJK:</span> A's 12px timestamps
            are the first thing to break in dense Chinese text; B and C both
            keep secondary text at 14px and lower contrast instead.
          </li>
        </ul>
      </div>
    </div>
  );
}
