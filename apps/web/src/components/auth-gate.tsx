import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useSession } from '~/lib/auth';

/**
 * Session guard for pages that need a signed-in user. UX only — the server
 * enforces the real permissions (protectedProcedure / adminProcedure).
 *
 * Lives in a component, not in `beforeLoad`: the better-auth client resolves
 * the session by fetching the server worker with `credentials: 'include'`,
 * and during SSR there is no browser cookie to include — a `beforeLoad`
 * check would bounce signed-in users to /login on first paint.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isPending } = useSession();

  useEffect(() => {
    // Bail once the login navigation is underway: history updates before
    // this gate unmounts, so without this guard the effect re-fires with
    // location already at /login and captures the /login URL itself as the
    // redirect target — nesting one encoding layer per pass.
    if (location.pathname === '/login') return;
    if (!isPending && !session) {
      void navigate({
        to: '/login',
        // Keep the original destination (path + search) for post-login.
        search: { redirect: location.pathname + location.searchStr },
        // Replace, don't push: with a pushed entry, Back returns to this
        // gated page, which instantly bounces forward to /login again — the
        // Back button appears dead. Replacing removes the gated page from
        // history, so Back goes where the user actually came from.
        replace: true,
      });
    }
  }, [isPending, session, navigate, location.pathname, location.searchStr]);

  // No flash of protected content while the session resolves.
  if (isPending || !session) {
    return (
      <main className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Checking session…
      </main>
    );
  }

  return children;
}
