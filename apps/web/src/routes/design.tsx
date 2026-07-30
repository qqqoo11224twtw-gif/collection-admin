import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { ArrowLeft, SwatchBook } from 'lucide-react';

export const Route = createFileRoute('/design')({
  component: DesignLayout,
});

const SECTIONS = [
  {
    to: '/design/overview',
    label: 'Overview',
    blurb: 'A full dashboard at real density, built from these tokens',
  },
  {
    to: '/design/scale',
    label: 'Type scale',
    blurb: 'Which steps each role picks, compared side by side',
  },
  {
    to: '/design/patterns',
    label: 'Patterns',
    blurb: 'Page-level layouts: tables, headers, empty states, danger zones',
  },
  {
    to: '/design/tokens',
    label: 'Tokens',
    blurb:
      'Type scale, spacing, color, radius — the values everything derives from',
  },
  {
    to: '/design/components',
    label: 'Components',
    blurb: 'Every shadcn component in every state',
  },
] as const;

/**
 * Local design-system reference. Not deployed — it exists so visual decisions
 * can be made against real density instead of in the abstract, and so
 * regressions are visible in one place after a component or token change.
 *
 * Delete this route if your product does not want it; nothing else imports it.
 */
function DesignLayout() {
  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-12 flex flex-col gap-10">
      <div className="flex flex-col gap-1 pb-6 border-b border-border/40">
        <div className="flex items-center gap-2">
          <SwatchBook className="w-6 h-6" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Design System
          </h1>
        </div>
        <p className="max-w-3xl text-muted-foreground text-sm leading-6">
          The reference for how application screens are built. Values shown here
          are the live ones — if it looks wrong here, it is wrong in the
          product.
        </p>
      </div>

      <div className="-mt-4 flex flex-col gap-6">
        <Link
          to="/"
          className="self-start text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 -ml-1"
        >
          <ArrowLeft size={16} />
          Back to Console
        </Link>

        <nav className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            /*
             * Colors live entirely in activeProps/inactiveProps, never in the
             * base className. Router merges those as plain strings, so
             * tailwind-merge never sees them — a base `text-muted-foreground`
             * would collide with the active `text-background` and win or lose
             * purely on stylesheet order.
             */
            <Link
              key={s.to}
              to={s.to}
              className="rounded-md border px-3 py-2 text-base font-medium transition-colors"
              activeProps={{
                className: 'border-foreground bg-foreground text-background',
              }}
              inactiveProps={{
                className:
                  'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
            >
              {s.label}
            </Link>
          ))}
        </nav>

        <div className="min-h-[400px]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
