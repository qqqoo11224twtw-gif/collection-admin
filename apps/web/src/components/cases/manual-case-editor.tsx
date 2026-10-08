import { REGIONS } from '@saasflare-dev/api/regions';
import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@saasflare-dev/ui/components/dialog';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useRefreshCases } from './management-hooks';

export function ManualCaseEditor() {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [warning, setWarning] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null),
    key = useRef(crypto.randomUUID()),
    refresh = useRefreshCases(),
    navigate = useNavigate();
  async function submit(override = false) {
    if (!form.current?.reportValidity()) return;
    setBusy(true);
    setError('');
    const data = new FormData(form.current),
      payload = new FormData();
    payload.append(
      'input',
      JSON.stringify({
        customerName: String(data.get('customerName')),
        code: String(data.get('code')),
        region: String(data.get('region')),
        address: String(data.get('address') || 'Not recorded'),
        amountDue: Number(data.get('amountDue') || 0),
        idempotencyKey: key.current,
        duplicateOverride: override,
      }),
    );
    for (const file of data.getAll('files'))
      if (file instanceof File && file.size) payload.append('files', file);
    try {
      const response = await fetch(
        `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/cases/manual`,
        { method: 'POST', credentials: 'include', body: payload },
      );
      const result = (await response.json()) as {
        kind?: string;
        id?: string;
        lastCreatedAt?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(result.message ?? 'Case could not be created.');
      if (result.kind === 'duplicate_warning') {
        setWarning(result.lastCreatedAt ?? '');
        return;
      }
      if (!result.id) throw new Error('Invalid creation response.');
      await refresh();
      setOpen(false);
      setWarning(null);
      await navigate({ to: '/cases/$caseId', params: { caseId: result.id } });
    } catch (failure: unknown) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not save this case.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setWarning(null);
          setError('');
          if (value) key.current = crypto.randomUUID();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>New case</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create case</DialogTitle>
          <DialogDescription>
            Enter the case details and upload finished images.
          </DialogDescription>
        </DialogHeader>
        {/* Finished private artwork and human-entered fields share one creation transaction. */}
        <form
          ref={form}
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="manual-files">Finished images</Label>
            <Input
              id="manual-files"
              name="files"
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
            />
            <p className="text-sm text-muted-foreground">
              PNG, JPEG or WebP · up to 5 images, 5 MiB each.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { key: 'code', label: 'Code', max: 60 },
              { key: 'customerName', label: 'Customer name', max: 120 },
            ].map((field) => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={`manual-${field.key}`}>{field.label}</Label>
                <Input
                  id={`manual-${field.key}`}
                  name={field.key}
                  maxLength={field.max}
                  required
                  disabled={busy}
                />
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <Label htmlFor="manual-region">Region</Label>
            <select
              id="manual-region"
              name="region"
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              required
              disabled={busy}
              defaultValue=""
            >
              <option value="">Choose a region</option>
              {REGIONS.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </div>
          <details open>
            <summary className="cursor-pointer text-sm">
              Optional case details
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="manual-address">Address</Label>
                <Input
                  id="manual-address"
                  name="address"
                  maxLength={500}
                  disabled={busy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-amount">Amount due (TWD)</Label>
                <Input
                  id="manual-amount"
                  name="amountDue"
                  type="number"
                  min={0}
                  max={1e12}
                  step={1}
                  disabled={busy}
                />
              </div>
            </div>
          </details>
          {warning !== null && (
            <div
              role="alertdialog"
              aria-label="Duplicate warning"
              className="space-y-3 rounded-lg bg-warning/10 p-4"
            >
              <p className="font-medium">發現疑似重複案件</p>
              <p className="text-sm">
                此代理 / 代號曾於{' '}
                {new Date(warning)
                  .toLocaleDateString('sv-SE')
                  .replaceAll('-', '/')}{' '}
                建檔過
              </p>
              <p className="text-sm">確定要繼續建立新案件嗎？</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setWarning(null)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void submit(true)}
                >
                  繼續建檔
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || warning !== null}>
              {busy ? 'Saving…' : 'Create case'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
