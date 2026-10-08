import { Button } from '@saasflare-dev/ui/components/button';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRound, LogIn, LogOut } from 'lucide-react';
import { useConfigStatus } from '~/components/config-notice';
import { signOut, useSession } from '~/lib/auth';

/**
 * Header account controls: Sign in when logged out, email + API keys +
 * sign-out when logged in. Renders nothing while the session resolves and on
 * AUTH_MODE=disabled deployments (no login story to point at).
 */
export function UserMenu() {
  const navigate = useNavigate();
  const { data: session, isPending } = useSession();
  const configQuery = useConfigStatus();

  if (configQuery.data?.authMode === 'disabled' || isPending) return null;

  if (!session) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link to="/login">
          <LogIn size={16} />
          登入
        </Link>
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className="max-w-40 truncate text-sm text-muted-foreground"
        title={session.user.email}
        data-testid="user-email"
      >
        {session.user.email}
      </span>
      <Button asChild variant="ghost" size="sm">
        <Link to="/examples/components/api-keys">
          <KeyRound size={16} />
          API 金鑰
        </Link>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void signOut().then(() => navigate({ to: '/', reloadDocument: true }))
        }
      >
        <LogOut size={16} />
        登出
      </Button>
    </div>
  );
}
