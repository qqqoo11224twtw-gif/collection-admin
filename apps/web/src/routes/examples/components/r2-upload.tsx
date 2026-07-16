import { createFileRoute } from '@tanstack/react-router';
import { AuthGate } from '~/components/auth-gate';
import { SourceCodeButton } from '~/components/source-code-button';
import { DeferredFileUploader } from '~/components/storage/deferred-file-uploader';

export const Route = createFileRoute('/examples/components/r2-upload')({
  component: R2UploadPage,
});

// The storage API is protectedProcedure (presigned uploads are a write
// vector), so the demo requires a session too.
function R2UploadPage() {
  return (
    <AuthGate>
      <div className="space-y-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              R2 Storage Demo
            </h1>
            <p className="text-muted-foreground mt-2">
              Direct S3-compatible file uploads with progress tracking.
            </p>
          </div>
          <SourceCodeButton path="apps/web/src/components/storage/deferred-file-uploader.tsx" />
        </div>
        <DeferredFileUploader />
      </div>
    </AuthGate>
  );
}
