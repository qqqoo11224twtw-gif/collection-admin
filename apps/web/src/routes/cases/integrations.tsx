import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { CaseError, LoadingCases } from '~/components/cases/presentation';
import { orpc } from '~/lib/orpc';

export const Route = createFileRoute('/cases/integrations')({
  component: IntegrationsPage,
});
function IntegrationsPage() {
  const permissions = useCasePermissions();
  const result = useQuery({
    ...orpc.config.integrations.queryOptions(),
    enabled: permissions.can('system_log.view'),
  });
  if (permissions.isPending) return <LoadingCases />;
  if (!permissions.can('system_log.view')) return <p>無操作權限</p>;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">系統整合狀態</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          僅顯示設定狀態，不提供任何憑證內容。Telegram 機器人請至 Telegram
          設定管理。
        </p>
      </header>
      {result.isPending ? (
        <LoadingCases />
      ) : result.isError ? (
        <CaseError retry={() => void result.refetch()} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            { label: 'Telegram 相容憑證', configured: result.data.telegram },
            { label: 'OpenAI 圖片辨識', configured: result.data.openai },
            { label: 'Email 寄信', configured: result.data.email },
            { label: '私人 R2 binding', configured: result.data.r2 },
            { label: 'Bot Token 加密', configured: result.data.botEncryption },
          ].map((item) => (
            <article key={item.label} className="rounded-xl border bg-card p-5">
              <h2 className="font-medium">{item.label}</h2>
              <p
                className={
                  'mt-3 text-sm ' +
                  (item.configured ? 'text-success' : 'text-muted-foreground')
                }
              >
                {item.configured ? '已設定' : '未設定'}
              </p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
