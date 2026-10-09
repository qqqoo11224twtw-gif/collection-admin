import { REGIONS } from '@saasflare-dev/api/regions';
import { Button } from '@saasflare-dev/ui/components/button';
import { Checkbox } from '@saasflare-dev/ui/components/checkbox';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@saasflare-dev/ui/components/dialog';
import { Input } from '@saasflare-dev/ui/components/input';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { orpc } from '~/lib/orpc';
import { DialogContent } from './localized-dialog';
import { useCasePermissions, useRefreshCases } from './management-hooks';

const reasons: Record<string, string> = {
  COLLECTOR_PRESENT: '已有外收人員，依只補空白模式跳過',
  COLLECTOR_UNAVAILABLE: '外收人員不存在或已停用',
  CASE_UNAVAILABLE: '案件不存在或無權限',
  RECORD_CHANGED: '案件已變更、已作廢或有衝突',
  PERMISSION_DENIED: '無操作權限',
  SAVE_FAILED: '儲存失敗',
  ALREADY_VOIDED: '案件已作廢',
};
export function BulkEditDialog({
  caseIds,
  onDone,
  voidMode = false,
}: {
  caseIds: string[];
  onDone: () => void;
  voidMode?: boolean;
}) {
  const [batchId, setBatchId] = useState(crypto.randomUUID());
  const permissions = useCasePermissions(),
    refresh = useRefreshCases();
  const [open, setOpen] = useState(false),
    [collectorSelected, setCollectorSelected] = useState(false),
    [regionSelected, setRegionSelected] = useState(false),
    [collectorId, setCollectorId] = useState(''),
    [region, setRegion] = useState(''),
    [mode, setMode] = useState<'fill_empty' | 'overwrite'>('fill_empty'),
    [confirmed, setConfirmed] = useState(false),
    [note, setNote] = useState(''),
    [error, setError] = useState('');
  const [result, setResult] = useState<{
    success: number;
    skipped: number;
    items: { caseId: string; status: string; reason: string }[];
  } | null>(null);
  const edit = useMutation(orpc.cases.bulkEdit.mutationOptions()),
    remove = useMutation(orpc.cases.bulkVoid.mutationOptions());
  const preview = useQuery({
    ...orpc.cases.bulkEditPreview.queryOptions({ input: { caseIds } }),
    enabled: open && !voidMode && caseIds.length > 0,
  });
  const collectors = useQuery({
    ...orpc.cases.bulkEditCollectors.queryOptions(),
    enabled: open && !voidMode && permissions.can('assignment.correct'),
  });
  const pending = edit.isPending || remove.isPending;
  const submit = async () => {
    setError('');
    try {
      const value = voidMode
        ? await remove.mutateAsync({ caseIds, note, confirmed: true })
        : await edit.mutateAsync({
            batchId,
            caseIds,
            fields: {
              ...(collectorSelected ? { collectorId } : {}),
              ...(regionSelected
                ? { region: region as (typeof REGIONS)[number] }
                : {}),
            },
            mode,
            confirmOverwrite: confirmed,
            note,
          });
      setResult(value);
      await refresh();
    } catch {
      setError('無法完成操作，請確認權限、欄位與案件狀態。');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (pending) return;
        setOpen(value);
        if (value) {
          setBatchId(crypto.randomUUID());
          setResult(null);
          setError('');
          setConfirmed(false);
          setMode('fill_empty');
          setCollectorSelected(false);
          setRegionSelected(false);
          setNote('');
        } else if (result) onDone();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" disabled={!caseIds.length}>
          {voidMode ? '批量刪除' : '批量編輯'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {result
              ? voidMode
                ? '批量作廢完成'
                : '批量編輯完成'
              : voidMode
                ? '批量作廢案件'
                : '批量編輯案件'}
          </DialogTitle>
          <DialogDescription>
            已選取 {caseIds.length} 筆案件
            {!voidMode ? ' · 僅修改明確勾選的欄位，不會發送 Telegram。' : ''}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3">
            <p>
              成功：{result.success} · 跳過：{result.skipped}
            </p>
            {result.items.map((item) => (
              <p key={item.caseId} className="break-all text-sm">
                {item.caseId} ·{' '}
                {item.status === 'success'
                  ? '成功'
                  : (reasons[item.reason] ?? '無法處理')}
              </p>
            ))}
            <Button
              onClick={() => {
                setOpen(false);
                onDone();
              }}
            >
              關閉
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {voidMode ? (
              <>
                <p className="text-sm text-destructive">
                  此操作只作廢，保留案件、圖片、委外、回報與財務歷史。選取案件可能已有
                  assignment、report、分期、payment、settlement 或 Telegram
                  job；作廢後不再接受正常下游操作。已送出的 Telegram
                  訊息無法收回。
                </p>
                <div className="flex items-start gap-2">
                  <Checkbox
                    aria-label="確認作廢"
                    checked={confirmed}
                    onCheckedChange={(v) => setConfirmed(v === true)}
                  />
                  我已確認關聯歷史與作廢影響
                </div>
              </>
            ) : (
              <>
                {permissions.can('assignment.correct') && (
                  <>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        aria-label="修改外收人員"
                        checked={collectorSelected}
                        onCheckedChange={(v) =>
                          setCollectorSelected(v === true)
                        }
                      />
                      外收人員（歷史補登）
                    </div>
                    {collectorSelected && (
                      <select
                        aria-label="補登外收人員"
                        className="w-full rounded-md border p-2"
                        value={collectorId}
                        onChange={(e) => setCollectorId(e.target.value)}
                      >
                        <option value="">選擇外收人員</option>
                        {collectors.data?.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.displayName}
                          </option>
                        ))}
                      </select>
                    )}
                    <p className="text-sm text-muted-foreground">
                      選取的案件中，有{' '}
                      {preview.data?.existingCollectorCount ?? '…'}{' '}
                      筆已有外收人員。
                    </p>
                    {collectorSelected && (
                      <>
                        <select
                          aria-label="外收補登模式"
                          value={mode}
                          onChange={(e) => {
                            setMode(e.target.value as typeof mode);
                            setConfirmed(false);
                          }}
                          className="w-full rounded-md border p-2"
                        >
                          <option value="fill_empty">只補空白</option>
                          <option value="overwrite">覆蓋所有已選取案件</option>
                        </select>
                        {mode === 'overwrite' && (
                          <div className="flex items-center gap-2">
                            <Checkbox
                              aria-label="確認覆蓋"
                              checked={confirmed}
                              onCheckedChange={(v) => setConfirmed(v === true)}
                            />
                            確認覆蓋外收人員並保留修正歷史
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
                <div className="flex items-center gap-2">
                  <Checkbox
                    aria-label="修改地區"
                    checked={regionSelected}
                    onCheckedChange={(v) => setRegionSelected(v === true)}
                  />
                  地區
                </div>
                {regionSelected && (
                  <select
                    aria-label="批量地區"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    className="w-full rounded-md border p-2"
                  >
                    <option value="">選擇地區</option>
                    {REGIONS.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                )}
              </>
            )}
            <Input
              aria-label="批量操作原因"
              placeholder="原因／備註（必填）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {error && <p role="alert">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                disabled={
                  pending ||
                  !note.trim() ||
                  (voidMode
                    ? !confirmed
                    : (!collectorSelected && !regionSelected) ||
                      (collectorSelected && !collectorId) ||
                      (regionSelected && !region) ||
                      (collectorSelected && mode === 'overwrite' && !confirmed))
                }
                onClick={() => void submit()}
              >
                {pending ? '處理中…' : voidMode ? '確認作廢' : '確認批量編輯'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
