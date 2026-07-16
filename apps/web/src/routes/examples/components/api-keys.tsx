import { createFileRoute } from '@tanstack/react-router';
import { ApiKeysManager } from '~/components/api-keys';
import { ApiUsageExamples } from '~/components/api-usage';
import { AuthGate } from '~/components/auth-gate';
import { SourceCodeButton } from '~/components/source-code-button';

export const Route = createFileRoute('/examples/components/api-keys')({
  component: ApiKeysPage,
});

/**
 * The machine-credential demo: humans sign in with a session cookie; external
 * systems call the API with a managed key. Management UI + live usage
 * snippets on one page.
 */
function ApiKeysPage() {
  return (
    <AuthGate>
      <div className="space-y-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              API Keys Demo
            </h1>
            <p className="text-muted-foreground mt-2">
              Stripe / OpenAI / Resend-style key management: create a revocable
              key, and external systems call your API with it — no browser
              session needed.
            </p>
          </div>
          <SourceCodeButton path="packages/api/src/api-keys.ts" />
        </div>
        <ApiKeysManager />
        <ApiUsageExamples />
      </div>
    </AuthGate>
  );
}
