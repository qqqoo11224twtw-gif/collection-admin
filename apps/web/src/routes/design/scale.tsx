import { Badge } from '@saasflare-dev/ui/components/badge';
import { cn } from '@saasflare-dev/ui/lib/utils';
import { createFileRoute } from '@tanstack/react-router';
import { formatAmount, PAYMENTS } from '~/components/design/fixtures';

export const Route = createFileRoute('/design/scale')({
  component: ScalePage,
});

/**
 * How application screens assign type steps. No token is modified on this
 * page: every specimen renders with Tailwind's stock scale. The standard is
 * about role assignment, not inventing new font sizes.
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

const LIFTED: Spec = {
  name: 'A · Lifted headings',
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
  name: 'B · Chinese-friendly dashboard',
  summary:
    'The default direction for SaaSFlare apps: body and secondary text stay at 14px, 12px is avoided in readable copy, and larger steps are reserved for tabs, real headings and metrics.',
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

const TYPE_RULES = [
  {
    role: 'Page title',
    className: 'text-2xl',
    size: '24px',
    use: 'Top-level screen title and major dashboard metric values.',
  },
  {
    role: 'Section heading',
    className: 'text-lg',
    size: '18px',
    use: 'Only when the content below is not self-explanatory.',
  },
  {
    role: 'Tabs / prominent card title',
    className: 'text-base',
    size: '16px',
    use: 'Route tabs, important settings card titles, and strong local headings.',
  },
  {
    role: 'Body / table / form',
    className: 'text-sm',
    size: '14px',
    use: 'Default floor for application UI: copy, labels, descriptions, table cells.',
  },
  {
    role: 'Compact metadata',
    className: 'text-xs',
    size: '12px',
    use: 'Badges, counts, timestamps, short monospace ids. Not explanatory copy.',
  },
] as const;

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
          Application UI uses Tailwind's named type steps only. Do not introduce
          arbitrary sizes such as <code className="font-mono">text-[15px]</code>
          for normal product surfaces; if the hierarchy needs a stronger step,
          move to the next token and reduce weight or contrast instead.
        </p>
        <p className="text-sm text-muted-foreground">
          The body floor is 14px. Secondary text stays 14px and recedes through
          <code className="font-mono"> text-muted-foreground</code>; 12px is
          reserved for compact metadata only. This keeps Chinese text readable
          without making dashboards feel like content pages.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium">Role</th>
              <th className="px-4 py-2.5 text-left font-medium">Class</th>
              <th className="px-4 py-2.5 text-left font-medium">Size</th>
              <th className="px-4 py-2.5 text-left font-medium">Use for</th>
            </tr>
          </thead>
          <tbody>
            {TYPE_RULES.map((rule) => (
              <tr
                key={rule.role}
                className="border-b border-border last:border-0"
              >
                <td className="px-4 py-3 font-medium">{rule.role}</td>
                <td className="px-4 py-3">
                  <code className="font-mono text-sm">{rule.className}</code>
                </td>
                <td className="px-4 py-3 font-mono tabular-nums">
                  {rule.size}
                </td>
                <td className="max-w-xl px-4 py-3 text-muted-foreground">
                  {rule.use}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Column spec={LIFTED} />
        <Column spec={SHADCN} />
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-4">
        <h2 className="text-base font-semibold">Operational rules</h2>
        <p className="text-sm text-muted-foreground">
          Section headings are a content decision, not decoration.{' '}
          <span className="text-foreground">
            Drop the heading when the content says what it is; keep it when a
            reader could be unsure what they are looking at.
          </span>{' '}
          A table of payments under a page titled Payments needs no label. Six
          same-shaped blocks on a settings page each need one, or people lose
          their place scrolling.
        </p>
        <p className="text-sm text-muted-foreground">
          Do not use arbitrary font-size utilities in app UI. The normal set is{' '}
          <code className="font-mono">text-xs</code>,{' '}
          <code className="font-mono">text-sm</code>,{' '}
          <code className="font-mono">text-base</code>,{' '}
          <code className="font-mono">text-lg</code>, and{' '}
          <code className="font-mono">text-2xl</code>. If a value outside that
          set seems necessary, first check whether color, weight, spacing, or
          layout is carrying the wrong job.
        </p>
      </div>
    </div>
  );
}
