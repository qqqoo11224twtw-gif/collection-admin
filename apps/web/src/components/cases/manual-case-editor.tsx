import { REGIONS } from '@saasflare-dev/api/regions';
import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@saasflare-dev/ui/components/dialog';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { displayError } from '~/components/cases/display-labels';
import { DialogContent } from '~/components/cases/localized-dialog';
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
        address: String(data.get('address') || '未填寫'),
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
      if (!response.ok) throw new Error(result.message ?? '無法建立案件。');
      if (result.kind === 'duplicate_warning') {
        setWarning(result.lastCreatedAt ?? '');
        return;
      }
      if (!result.id) throw new Error('建立案件的回應無效。');
      await refresh();
      setOpen(false);
      setWarning(null);
      await navigate({ to: '/cases/$caseId', params: { caseId: result.id } });
    } catch (failure: unknown) {
      setError(displayError(failure, '無法儲存案件。'));
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
        <Button>新增案件</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新增案件</DialogTitle>
          <DialogDescription>請填寫案件資料並上傳委外圖片。</DialogDescription>
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
            <Label htmlFor="manual-files">委外圖片</Label>
            <Input
              id="manual-files"
              name="files"
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
            />
            <p className="text-sm text-muted-foreground">
              支援 PNG、JPEG 或 WebP · 最多 5 張 · 每張上限 5 MiB。
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { key: 'code', label: '代號', max: 60 },
              { key: 'customerName', label: '客戶姓名', max: 120 },
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
            <Label htmlFor="manual-region">地區</Label>
            <select
              id="manual-region"
              name="region"
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              required
              disabled={busy}
              defaultValue=""
            >
              <option value="">請選擇地區</option>
              {REGIONS.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </div>
          <details open>
            <summary className="cursor-pointer text-sm">
              案件資料（選填）
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="manual-address">地址</Label>
                <Input
                  id="manual-address"
                  name="address"
                  maxLength={500}
                  disabled={busy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-amount">應收款項（新臺幣）</Label>
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
              aria-label="重複建案提醒"
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
              取消
            </Button>
            <Button type="submit" disabled={busy || warning !== null}>
              {busy ? '儲存中…' : '新增案件'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
