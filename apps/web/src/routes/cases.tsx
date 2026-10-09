import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { AuthGate } from '~/components/auth-gate';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { ReviewNotice } from '~/components/cases/review-notice';
import { UserMenu } from '~/components/user-menu';

export const Route = createFileRoute('/cases')({ component: CaseWorkspace });
function CaseWorkspace() {
  const permissions = useCasePermissions();
  return (
    <AuthGate>
      <main className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-8 md:px-8">
        {/* Workspace navigation and explicit demo-data context. */}
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Link
            to="/"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← 後台首頁
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            {permissions.can('intake.view') && (
              <Link
                to="/cases/intake"
                search={{ page: 1, query: '', status: '', source: '' }}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                收件管理
              </Link>
            )}
            <ReviewNotice />
            <Link
              to="/cases/regions"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              地區調度
            </Link>
            {permissions.can('settlement.view') && (
              <Link
                to="/cases/finance"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                財務管理
              </Link>
            )}
            {permissions.can('telegram_route.manage') && (
              <Link
                to="/cases/telegram"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Telegram 設定
              </Link>
            )}
            {permissions.can('collector.manage') && (
              <Link
                to="/cases/collectors"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                外收人員
              </Link>
            )}
            <UserMenu />
            {permissions.can('user_permission.manage') && (
              <Link
                to="/cases/users"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                使用者與權限
              </Link>
            )}
            {permissions.can('system_log.view') && (
              <Link
                to="/cases/system-logs"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                系統管理日誌
              </Link>
            )}
          </div>
        </div>
        <div className="rounded-lg bg-info/5 px-4 py-3 text-sm text-muted-foreground">
          本機示範環境 · 所有案件與圖片皆為虛構資料，未連接正式服務。
        </div>
        <Outlet />
      </main>
    </AuthGate>
  );
}
