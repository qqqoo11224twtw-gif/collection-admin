import { Toaster } from '@saasflare-dev/ui/components/sonner';
import { TooltipProvider } from '@saasflare-dev/ui/components/tooltip';
import uiGlobalsCss from '@saasflare-dev/ui/styles/globals.css?url';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import { ThemeProvider } from 'next-themes';
import { APP_ID } from '~/lib/brand';
import globalsCss from '~/styles/globals.css?url';

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      // Single-sourced from package.json `saasflare` (docs/ports.md).
      { title: '案件管理後台' },
      {
        name: 'description',
        content:
          '基於 Cloudflare Workers 的 SaaS 專案，使用 Hono、oRPC、TanStack Start 與 better-auth。',
      },
    ],
    links: [
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'stylesheet', href: uiGlobalsCss },
      { rel: 'stylesheet', href: globalsCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    // data-app is a stable per-product identity anchor (decoupled from page
    // copy). The E2E guard (e2e/global-setup.ts) uses it to confirm it's
    // testing THIS app and not another saasflare product sharing port 3000.
    // Forked products must give this a unique value.
    // suppressHydrationWarning is required by next-themes: its inline script
    // stamps a class and color-scheme onto <html> before React hydrates.
    <html lang="zh-TW" data-app={APP_ID} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased" suppressHydrationWarning>
        {/* Product dark mode: `forcedTheme` pins the app to
            light so nothing follows the OS setting. To turn dark mode on, drop
            `forcedTheme`, add a theme switcher, and tune the `.dark` tokens in
            packages/ui — they are still shadcn factory values. */}
        <ThemeProvider attribute="class" forcedTheme="dark">
          <TooltipProvider>
            <div className="min-h-svh w-full flex flex-col">
              <Outlet />
            </div>
            <Toaster richColors />
          </TooltipProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
