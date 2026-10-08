import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@saasflare-dev/ui/components/tooltip';
import { cn } from '@saasflare-dev/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  Check,
  CircleAlert,
  Database,
  Github,
  Globe,
  HardDrive,
  KeyRound,
  LayoutTemplate,
  Loader2,
  type LucideIcon,
  Server,
  Terminal,
  Workflow,
} from 'lucide-react';
import { ConfigNotice, useConfigStatus } from '~/components/config-notice';
import { UserMenu } from '~/components/user-menu';
import { APP_DISPLAY_NAME } from '~/lib/brand';
import { orpc } from '~/lib/orpc';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  const configQuery = useConfigStatus();
  return (
    <main className="w-full max-w-5xl mx-auto px-4 py-12 flex flex-col gap-12">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-6 border-b border-border/40">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Terminal className="w-6 h-6" />
            {APP_DISPLAY_NAME} 後台
          </h1>
          <p className="text-muted-foreground">
            系統運作正常。{' '}
            <span className="text-success font-medium">可接收請求。</span>
          </p>
        </div>
        <UserMenu />
      </div>

      <Link
        to="/cases"
        search={{ query: '', page: 1 }}
        className="rounded-xl bg-card p-5 shadow-xs ring-1 ring-foreground/10 hover:bg-muted"
      >
        <span className="text-lg font-medium">案件管理 →</span>
        <span className="mt-2 block text-sm text-muted-foreground">
          瀏覽虛構案件、搜尋資料與查看私人示範圖片。
        </span>
      </Link>

      <ConfigNotice status={configQuery.data} />

      {/* System Status */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          系統狀態
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatusCheckCard
            title="API 連線"
            description="Hono Worker via ORPC"
            queryKey="connection"
            icon={Server}
          />
          <StatusCheckCard
            title="KV 儲存空間"
            description="Cloudflare Workers KV"
            queryKey="kv"
            icon={Workflow}
          />
          <StatusCheckCard
            title="D1 Database"
            description="無伺服器 SQLite 邊緣資料庫"
            queryKey="db"
            icon={Database}
          />
          <StatusCheckCard
            title="R2 儲存空間"
            description="物件儲存"
            queryKey="r2"
            icon={HardDrive}
          />
        </div>
      </section>

      {/* Examples — linked straight from the console, no hub page */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          範例
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <ExampleCard
            title="個人資料 — 待辦清單"
            description="帳號專屬待辦清單，示範使用者資料隔離。"
            href="/examples/components/todos"
            icon={LayoutTemplate}
          />
          <ExampleCard
            title="API 金鑰驗證"
            description="Create a key, then call the external API (GET /api/v1/whoami) with it."
            href="/examples/components/api-keys"
            icon={KeyRound}
          />
          <ExampleCard
            title="檔案上傳 — R2"
            description="使用預簽署網址上傳檔案並追蹤進度。"
            href="/examples/components/r2-upload"
            icon={HardDrive}
          />
          <ExampleCard
            title="伺服器端資料載入"
            description="使用 TanStack Query 預先載入資料並在伺服器呈現。"
            href="/examples/ssr"
            icon={Server}
          />
        </div>
      </section>

      {/* Quick Links / Resources */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          資源
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <ResourceCard
            title="TanStack Start Docs"
            href="https://tanstack.com/start/latest"
            icon={Globe}
          />
          <ResourceCard
            title="Hono Docs"
            href="https://hono.dev"
            icon={Globe}
          />
          <ResourceCard
            title="ORPC Docs"
            href="https://orpc.dev"
            icon={Globe}
          />
          <ResourceCard
            title="Cloudflare Docs"
            href="https://developers.cloudflare.com/workers/"
            icon={Globe}
          />
        </div>
      </section>

      {/* Footer */}
      <div className="mt-auto pt-12 flex flex-col items-center gap-4 border-t border-border/40">
        <a
          href="https://github.com/saasflare-dev/starter"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-muted"
        >
          <Github size={16} />
          GitHub
        </a>
        <p className="text-xs text-muted-foreground font-mono">
          編輯{' '}
          <span className="bg-muted px-1 py-0.5 rounded text-foreground">
            apps/web/src/routes/index.tsx
          </span>{' '}
          開始建立應用程式。
        </p>
      </div>
    </main>
  );
}

function ExampleCard({
  title,
  description,
  href,
  icon: Icon,
  disabled = false,
}: {
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
  disabled?: boolean;
}) {
  const Content = (
    <>
      <div
        className={cn(
          'p-2 rounded-md transition-colors',
          disabled
            ? 'bg-muted text-muted-foreground'
            : 'bg-muted text-muted-foreground group-hover:text-foreground group-hover:bg-background',
        )}
      >
        <Icon size={20} />
      </div>
      <div>
        <h3 className="text-sm font-medium text-foreground leading-none mb-1">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground line-clamp-2">
          {description}
        </p>
      </div>
    </>
  );

  if (disabled) {
    return (
      <div className="flex items-center gap-4 p-4 rounded-lg border border-border bg-muted/30 opacity-60 cursor-not-allowed">
        {Content}
      </div>
    );
  }

  return (
    <Link
      to={href}
      className="group flex items-center gap-4 p-4 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors hover:shadow-sm hover:border-primary/20"
    >
      {Content}
    </Link>
  );
}

function ResourceCard({
  title,
  href,
  icon: Icon,
}: {
  title: string;
  href: string;
  icon: LucideIcon;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-3 p-4 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors"
    >
      <div className="p-2 rounded-md bg-muted group-hover:bg-background transition-colors">
        <Icon
          size={18}
          className="text-muted-foreground group-hover:text-foreground"
        />
      </div>
      <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
        {title}
      </span>
    </a>
  );
}

function StatusCheckCard({
  title,
  description,
  queryKey,
  icon: Icon,
}: {
  title: string;
  description: string;
  queryKey: 'connection' | 'kv' | 'db' | 'r2';
  icon: LucideIcon;
}) {
  const query = useQuery(orpc.healthCheck[queryKey].queryOptions());

  return (
    <div className="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
      <div className="flex items-center gap-4">
        <div className="p-2 bg-muted rounded-md text-muted-foreground">
          <Icon size={20} />
        </div>
        <div>
          <h3 className="text-sm font-medium text-foreground leading-none mb-1">
            {title}
          </h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border transition-colors',
              query.isLoading
                ? 'bg-muted text-muted-foreground border-transparent'
                : query.isError || !query.data
                  ? 'bg-destructive/10 text-destructive border-destructive/20'
                  : 'bg-success/10 text-success border-success/20',
            )}
          >
            {query.isLoading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : query.isError || !query.data ? (
              <CircleAlert size={12} />
            ) : (
              <Check size={12} />
            )}
            <span className="capitalize">
              {query.isLoading
                ? '檢查中'
                : query.isError || !query.data
                  ? '錯誤'
                  : '正常'}
            </span>
          </div>
        </TooltipTrigger>
        {query.isError && (
          <TooltipContent>
            <p className="text-xs">{query.error.message}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </div>
  );
}
