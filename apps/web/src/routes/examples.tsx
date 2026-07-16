import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { ArrowLeft, FlaskConical } from 'lucide-react';

export const Route = createFileRoute('/examples')({
  component: ExamplesLayout,
});

/**
 * Shared frame for the example pages. There is no /examples hub — the
 * example cards live on the home console, so navigation always leads back
 * there.
 */
function ExamplesLayout() {
  return (
    // Same max-w-4xl as the page content below, so the header lines up
    // flush with each example instead of hanging wider.
    <div className="w-full max-w-4xl mx-auto px-4 py-12 flex flex-col gap-12">
      {/* Shared Header */}
      <div className="flex flex-col gap-1 pb-6 border-b border-border/40">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-6 h-6" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Examples
          </h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Working examples of the template's integration patterns.
        </p>
      </div>

      {/* Below the divider, above the page content */}
      <div className="-mt-6 flex flex-col gap-8">
        <Link
          to="/"
          className="self-start text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 -ml-1"
        >
          <ArrowLeft size={16} />
          Back to Console
        </Link>

        {/* Page Content */}
        <div className="min-h-[400px]">
          <Outlet />
        </div>
      </div>

      {/* Hint */}
      <div className="mt-auto pt-6 border-t border-border/40 text-center">
        <p className="text-xs text-muted-foreground font-mono">
          Add new examples in{' '}
          <span className="bg-muted px-1 py-0.5 rounded text-foreground">
            apps/web/src/routes/examples/
          </span>
        </p>
      </div>
    </div>
  );
}
