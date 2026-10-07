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
import { Textarea } from '@saasflare-dev/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { orpc } from '~/lib/orpc';
import { useRefreshCases } from './management-hooks';
import type { CaseRecord } from './presentation';

const selectClass =
  'h-9 w-full rounded-lg border border-input bg-background px-3 text-sm';
export function CaseEditor({ record }: { record?: CaseRecord }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const create = useMutation(orpc.cases.create.mutationOptions());
  const edit = useMutation(orpc.cases.edit.mutationOptions());
  const refresh = useRefreshCases();
  const navigate = useNavigate();
  const busy = create.isPending || edit.isPending;
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
          {record ? 'Edit case' : 'New case'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{record ? 'Edit case' : 'Create case'}</DialogTitle>
          <DialogDescription>
            {record
              ? 'Case number and original creation details stay fixed.'
              : 'A unique case number will be generated when you save.'}
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
                address: text('address'),
                amountDue: Number(text('amountDue')),
                status: text('status') as CaseRecord['status'],
                revisitStatus: text(
                  'revisitStatus',
                ) as CaseRecord['revisitStatus'],
                revisitReason: text('revisitReason'),
              };
              try {
                if (record)
                  await edit.mutateAsync({
                    ...fields,
                    id: record.id,
                    expectedVersion: record.version,
                  });
                else {
                  const created = await create.mutateAsync({
                    ...fields,
                    source: text('source') as CaseRecord['source'],
                  });
                  await navigate({
                    to: '/cases/$caseId',
                    params: { caseId: created.id },
                  });
                }
                await refresh();
                setOpen(false);
              } catch (failure: unknown) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : 'Unable to save this case.',
                );
              }
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                {
                  name: 'customerName',
                  label: 'Customer name',
                  max: 120,
                  value: record?.customerName,
                },
                { name: 'code', label: 'Code', max: 60, value: record?.code },
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
              <Label htmlFor="case-address">Address</Label>
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
                <Label htmlFor="case-amount">Amount due (TWD)</Label>
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
                <Label htmlFor="case-status">Status</Label>
                <select
                  id="case-status"
                  name="status"
                  className={selectClass}
                  defaultValue={record?.status ?? 'pending'}
                >
                  {[
                    'pending',
                    'assigned',
                    'follow_up',
                    'installment',
                    'settled',
                    'unresolved',
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="case-revisit">Revisit status</Label>
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
                      {value.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </div>
              {!record && (
                <div className="space-y-2">
                  <Label htmlFor="case-source">Source</Label>
                  <select
                    id="case-source"
                    name="source"
                    className={selectClass}
                    defaultValue="manual"
                  >
                    {[
                      'manual',
                      'poster_builder',
                      'telegram_ai',
                      'historical_import',
                    ].map((value) => (
                      <option key={value} value={value}>
                        {value.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="case-reason">Revisit reason</Label>
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
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : record ? 'Save changes' : 'Create case'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
