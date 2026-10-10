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
import { Textarea } from '@saasflare-dev/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { displayError, displayLabel } from '~/components/cases/display-labels';
import { DialogContent } from '~/components/cases/localized-dialog';
import { orpc } from '~/lib/orpc';
import { useRefreshCases } from './management-hooks';
import { ManualCaseEditor } from './manual-case-editor';
import type { CaseRecord } from './presentation';

const selectClass =
  'h-9 w-full rounded-lg border border-input bg-background px-3 text-sm';
export function CaseEditor({ record }: { record?: CaseRecord }) {
  return record ? <CaseEditorForm record={record} /> : <ManualCaseEditor />;
}
function CaseEditorForm({ record }: { record: CaseRecord }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const edit = useMutation(orpc.cases.edit.mutationOptions());
  const refresh = useRefreshCases();
  const busy = edit.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={record ? 'outline' : 'default'}>
          {record ? '編輯案件' : '新增案件'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{record ? '編輯案件' : '新增案件'}</DialogTitle>
          <DialogDescription>
            {record
              ? '案件編號與原始建立資訊無法修改。'
              : '儲存時由系統產生案件編號。'}
          </DialogDescription>
        </DialogHeader>
        {/* The server validates every field; immutable identity fields are never submitted. */}
        {open && (
          <form
            className="space-y-5"
            onSubmit={async (event) => {
              event.preventDefault();
              setError('');
              const data = new FormData(event.currentTarget);
              const text = (name: string) => String(data.get(name) ?? '');
              const fields = {
                customerName: text('customerName'),
                code: text('code'),
                region: (text('region') || null) as CaseRecord['region'],
                address: text('address'),
                amountDue: Number(text('amountDue')),
                status: (text('status') === 'direct_to_principal'
                  ? 'settled'
                  : text('status')) as Exclude<
                  CaseRecord['status'],
                  'direct_to_principal'
                >,
                revisitStatus: text(
                  'revisitStatus',
                ) as CaseRecord['revisitStatus'],
                revisitReason: text('revisitReason'),
              };
              try {
                await edit.mutateAsync({
                  ...fields,
                  id: record.id,
                  expectedVersion: record.version,
                });
                await refresh();
                setOpen(false);
              } catch (failure: unknown) {
                setError(displayError(failure, '無法儲存案件，請重試。'));
              }
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                {
                  name: 'customerName',
                  label: '客戶姓名',
                  max: 120,
                  value: record?.customerName,
                },
                { name: 'code', label: '代號', max: 60, value: record?.code },
              ].map((field) => (
                <div key={field.name} className="space-y-2">
                  <Label htmlFor={`case-${field.name}`}>{field.label}</Label>
                  <Input
                    id={`case-${field.name}`}
                    name={field.name}
                    required
                    maxLength={field.max}
                    defaultValue={field.value}
                  />
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <Label htmlFor="case-region">地區</Label>
              <select
                id="case-region"
                name="region"
                defaultValue={record?.region ?? ''}
                className={selectClass}
              >
                <option value="">未填寫</option>
                {REGIONS.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="case-address">地址</Label>
              <Input
                id="case-address"
                name="address"
                required
                maxLength={500}
                defaultValue={record?.address}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="case-amount">應收款項（新臺幣）</Label>
                <Input
                  id="case-amount"
                  name="amountDue"
                  type="number"
                  min={0}
                  max={1e12}
                  step={1}
                  required
                  defaultValue={record?.amountDue ?? 0}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="case-status">案件狀態</Label>
                <select
                  id="case-status"
                  name="status"
                  className={selectClass}
                  defaultValue={record?.status ?? 'pending'}
                >
                  {record?.status === 'direct_to_principal' && (
                    <option value="direct_to_principal">後結</option>
                  )}
                  {[
                    'pending',
                    'assigned',
                    'follow_up',
                    'installment',
                    'settled',
                    'unresolved',
                  ].map((value) => (
                    <option key={value} value={value}>
                      {displayLabel(value)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="case-revisit">二訪狀態</Label>
                <select
                  id="case-revisit"
                  name="revisitStatus"
                  className={selectClass}
                  defaultValue={record?.revisitStatus ?? 'pending'}
                >
                  {[
                    'pending',
                    'recommended',
                    'not_required',
                    'observe',
                    'not_recommended',
                    'not_needed',
                  ].map((value) => (
                    <option key={value} value={value}>
                      {displayLabel(value)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="case-reason">二訪原因</Label>
              <Textarea
                id="case-reason"
                name="revisitReason"
                maxLength={2000}
                defaultValue={record?.revisitReason}
              />
            </div>
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
              <Button type="submit" disabled={busy}>
                {busy ? '儲存中…' : record ? '儲存變更' : '新增案件'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
