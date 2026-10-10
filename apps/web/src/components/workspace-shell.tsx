import { Button } from '@saasflare-dev/ui/components/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@saasflare-dev/ui/components/sheet';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import {
  CalendarClock,
  ChevronRight,
  FolderOpen,
  Home,
  LogOut,
  Menu,
  Wallet,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { AuthGate } from '~/components/auth-gate';
import { BrandLogo } from '~/components/brand-logo';
import { GlobalCaseSearch } from '~/components/cases/global-search';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { signOut, useSession } from '~/lib/auth';
import { orpc } from '~/lib/orpc';

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const permissions = useCasePermissions();
  const { data: session } = useSession();
  const viewer = useQuery({
    ...orpc.cases.viewer.queryOptions(),
    enabled: !!session,
  });
  const pendingReviews = useQuery({
    ...orpc.reviews.pendingCount.queryOptions(),
    enabled: permissions.can('review.view') && permissions.can('case.view'),
  });
  const priorityOptions = orpc.installments.priorityCount.queryOptions();
  const priority = useQuery({
    ...priorityOptions,
    queryKey: [session?.user.id, ...priorityOptions.queryKey],
    enabled:
      !!session &&
      permissions.can('case.view') &&
      permissions.can('installment.view'),
    staleTime: 30000,
    refetchInterval: 60000,
  });
  const location = useLocation();
  const navigate = useNavigate();
  const [more, setMore] = useState(false);
  const items = [
    { label: '儀表總覽', to: '/', visible: true },
    { label: '我的帳號', to: '/cases/profile', visible: true },
    { label: '案件管理', to: '/cases', visible: permissions.can('case.view') },
    {
      label: '分期客追蹤',
      to: '/cases/installments',
      visible:
        permissions.can('case.view') && permissions.can('installment.view'),
    },
    {
      label: '待確認',
      to: '/cases/reviews',
      visible: permissions.can('review.view'),
    },
    {
      label: '地區調度',
      to: '/cases/regions',
      visible: permissions.can('case.view'),
    },
    {
      label: '外收人員',
      to: '/cases/collectors',
      visible: permissions.can('collector.manage'),
    },
    {
      label: permissions.can('case.view_all') ? '財務管理' : '我的財務',
      to: '/cases/finance',
      visible: permissions.can('settlement.view'),
    },
    {
      label: 'Telegram 設定',
      to: '/cases/telegram',
      visible:
        permissions.can('telegram_route.manage') ||
        permissions.can('telegram_bot.manage'),
    },
    {
      label: '帳號管理',
      to: '/cases/users',
      visible: permissions.can('user_permission.manage'),
    },
    {
      label: '系統整合狀態',
      to: '/cases/integrations',
      visible: permissions.can('system_log.view'),
    },
    {
      label: '系統管理日誌',
      to: '/cases/system-logs',
      visible: permissions.can('system_log.view'),
    },
  ].filter((item) => item.visible);
  const logout = () =>
    void signOut().then(() => navigate({ to: '/login', reloadDocument: true }));
  const links = items.map((item) => (
    <Link
      key={item.to}
      to={item.to}
      onClick={() => setMore(false)}
      className={`block rounded-lg px-3 py-3 text-sm font-medium ${location.pathname.replace(/\/$/, '') === item.to ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
    >
      <span className="flex items-center justify-between gap-2">
        {item.label}
        {item.to === '/cases/reviews' && pendingReviews.data !== undefined && (
          <span className="ml-auto rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary">
            {pendingReviews.data}
          </span>
        )}
        {item.to === '/cases/installments' && priority.data !== undefined && (
          <span className="ml-auto rounded-md bg-warning/10 px-2 py-0.5 text-xs text-warning">
            {priority.data}
          </span>
        )}
        <ChevronRight className="size-3 opacity-40" />
      </span>
    </Link>
  ));
  return (
    <AuthGate>
      <div className="min-h-svh lg:pl-64">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-card px-4 py-6 lg:flex">
          <BrandLogo />
          <nav
            aria-label="主要導覽"
            className="mt-8 flex-1 space-y-1 overflow-y-auto"
          >
            {[
              { title: '總覽', paths: ['/'] },
              {
                title: '案件',
                paths: ['/cases', '/cases/reviews'],
              },
              { title: '調度', paths: ['/cases/regions', '/cases/collectors'] },
              {
                title: '財務',
                paths: ['/cases/installments', '/cases/finance'],
              },
              { title: 'Telegram', paths: ['/cases/telegram'] },
              {
                title: '系統管理',
                paths: [
                  '/cases/users',
                  '/cases/system-logs',
                  '/cases/integrations',
                ],
              },
            ]
              .filter((group) =>
                items.some((item) => group.paths.includes(item.to)),
              )
              .map((group) => (
                <div key={group.title} className="mb-4">
                  <p className="mb-1 px-3 text-xs text-muted-foreground">
                    {group.title}
                  </p>
                  {links.filter((link) =>
                    group.paths.includes(String(link.key)),
                  )}
                </div>
              ))}
          </nav>
          <div className="mt-4 space-y-2 border-t pt-4">
            <p className="truncate text-sm" data-testid="user-email">
              {viewer.data?.username ?? session?.user.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {(
                {
                  admin: '管理員',
                  manager: '主管',
                  user: '外收人員',
                  reviewer: '審核人員',
                  finance: '財務人員',
                  restricted: '受限使用者',
                } as Record<string, string>
              )[viewer.data?.role ?? ''] ?? '系統使用者'}
            </p>
            <Button variant="ghost" onClick={logout}>
              <LogOut className="size-4" />
              登出
            </Button>
          </div>
        </aside>
        <header className="border-b bg-card px-4 py-4 lg:hidden">
          <BrandLogo />
        </header>
        <div className="hidden lg:block">
          <GlobalCaseSearch />
        </div>
        <main className="mx-auto w-full min-w-0 max-w-7xl space-y-6 px-4 py-6 pb-36 md:px-8 lg:pb-8">
          {children}
        </main>
        <Sheet open={more} onOpenChange={setMore}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="max-h-[85svh] overflow-y-auto rounded-t-2xl p-5 pb-8"
          >
            <SheetTitle>更多功能</SheetTitle>
            <SheetDescription>前往管理功能與帳號設定。</SheetDescription>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">功能導覽</span>
              <Button variant="ghost" onClick={() => setMore(false)}>
                關閉
              </Button>
            </div>
            {links}
            <Button variant="ghost" onClick={logout}>
              登出
            </Button>
          </SheetContent>
        </Sheet>
        <nav
          aria-label="手機導覽"
          className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t bg-card px-2 py-3 pb-5 lg:hidden"
        >
          {[
            { label: '首頁', to: '/', icon: Home, visible: true },
            {
              label: '案件',
              to: '/cases',
              icon: FolderOpen,
              visible: permissions.can('case.view'),
            },
            {
              label: '分期客追蹤',
              to: '/cases/installments',
              icon: CalendarClock,
              visible:
                permissions.can('case.view') &&
                permissions.can('installment.view'),
            },
            {
              label: '財務',
              to: '/cases/finance',
              icon: Wallet,
              visible: permissions.can('settlement.view'),
            },
          ]
            .filter((item) => item.visible)
            .map(({ label, to, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={`flex min-w-12 flex-col items-center gap-1 text-xs ${location.pathname === to ? 'text-primary' : 'text-muted-foreground'}`}
              >
                <Icon className="size-5" />
                {label}
              </Link>
            ))}
          <button
            type="button"
            className="flex min-w-12 flex-col items-center gap-1 text-xs text-muted-foreground"
            onClick={() => setMore(!more)}
            aria-expanded={more}
          >
            <Menu className="size-5" />
            更多
          </button>
        </nav>
      </div>
    </AuthGate>
  );
}
