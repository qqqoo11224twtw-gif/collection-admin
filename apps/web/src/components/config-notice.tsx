import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@saasflare-dev/ui/components/alert';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Settings2 } from 'lucide-react';
import { orpc } from '~/lib/orpc';

export type ConfigStatus = {
  authMode: 'disabled' | 'open' | 'admin-only';
  mode: 'local' | 'deployed';
  missing: string[];
  warnings: string[];
};

/**
 * Pre-auth server configuration probe (current AUTH_MODE + names of unset
 * vars, never values). This is the frontend's single source of truth for the
 * auth mode — no duplicated env on the web side.
 */
export function useConfigStatus() {
  return useQuery(orpc.config.status.queryOptions({ staleTime: 60_000 }));
}

/**
 * Banner listing missing / degraded server configuration. `missing` entries
 * are blockers (red); `warnings` mean the app works but degraded.
 */
export function ConfigNotice({ status }: { status: ConfigStatus | undefined }) {
  if (!status || (status.missing.length === 0 && status.warnings.length === 0))
    return null;

  const emailVars = [...status.missing, ...status.warnings].filter(
    (v) => v === 'RESEND_API_KEY' || v === 'EMAIL_FROM',
  );

  return (
    <div className="flex flex-col gap-2">
      {status.missing.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle size={16} />
          <AlertTitle>伺服器設定缺漏</AlertTitle>
          <AlertDescription>
            此登入模式需要設定 AUTH_MODE={status.authMode}:{' '}
            {status.missing.join(', ')}。請參閱 docs/auth.md。
          </AlertDescription>
        </Alert>
      )}
      {status.warnings.length > 0 && (
        <Alert>
          <Settings2 size={16} />
          <AlertTitle>設定不完整</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            {emailVars.length > 0 && status.mode === 'local' && (
              <span>
                未設定寄信服務（{emailVars.join(' / ')}
                ）：登入驗證碼會顯示於伺服器主控台及 /api/dev/otp。
              </span>
            )}
            <span>
              尚未設定： {status.warnings.join(', ')}。請參閱 docs/auth.md。
            </span>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
