import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';

export const Route = createFileRoute('/design/')({
  component: DesignIndex,
});

const SECTIONS = [
  {
    to: '/design/patterns',
    label: 'Patterns',
    blurb:
      'Page-level layouts — data tables, page headers, empty states, danger zones. What actually makes screens feel like one product.',
  },
  {
    to: '/design/tokens',
    label: 'Tokens',
    blurb:
      'Type scale, line height, spacing, color, radius. Every utility dereferences these, so changing one restyles everything.',
  },
  {
    to: '/design/components',
    label: 'Components',
    blurb:
      'Each shadcn component with its states — default, hover, disabled, loading, error.',
  },
] as const;

function DesignIndex() {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Why this page exists
        </h2>
        <div className="text-sm text-muted-foreground flex flex-col gap-2 max-w-2xl">
          <p>
            Components alone do not make screens look like one product — a
            Button is a Button everywhere. What differs between screens is the
            layer above: how dense a table is, where destructive actions live,
            what an empty state says. Those are the patterns collected here.
          </p>
          <p>
            It doubles as a regression baseline. After changing a token or
            re-pulling a component, this page shows what moved.
          </p>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {SECTIONS.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="group flex flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/40"
          >
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {s.label}
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
            <span className="text-xs text-muted-foreground">{s.blurb}</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
