import type { AppRouterClient } from '@saasflare-dev/api';
import { REGIONS } from '@saasflare-dev/api/regions';
import { Button } from '@saasflare-dev/ui/components/button';
import { Checkbox } from '@saasflare-dev/ui/components/checkbox';
import { Input } from '@saasflare-dev/ui/components/input';
import { Textarea } from '@saasflare-dev/ui/components/textarea';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  BulkRowImages,
  type RowImage,
} from '~/components/cases/bulk-row-images';
import {
  useCasePermissions,
  useRefreshCases,
} from '~/components/cases/management-hooks';
import { orpc } from '~/lib/orpc';

export const Route = createFileRoute('/cases/bulk-create')({
  component: BulkCreatePage,
});
type InputData = Parameters<AppRouterClient['cases']['bulkCreate']>[0];
type Row = Required<InputData['rows'][number]>;
const emptyRow = (): Row => ({
  code: '',
  customerName: '',
  region: '',
  address: '',
  collector: '',
  duplicateOverride: false,
  imageCount: 0,
});

function BulkCreatePage() {
  const permissions = useCasePermissions(),
    refresh = useRefreshCases();
  const [mode, setMode] = useState<'new' | 'historical' | null>(null);
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [images, setImages] = useState<RowImage[][]>([[]]);
  const [uploading, setUploading] = useState(false);
  const [mediaResults, setMediaResults] = useState<Record<number, string>>({});
  const updateImageState = (
    index: number,
    id: string,
    state: RowImage['state'],
    mediaId?: string,
  ) =>
    setImages((old) =>
      old.map((row, i) =>
        i === index
          ? row.map((image) =>
              image.id === id
                ? { ...image, state, mediaId: mediaId ?? image.mediaId }
                : image,
            )
          : row,
      ),
    );
  async function uploadRows(
    results: Awaited<
      ReturnType<AppRouterClient['cases']['bulkCreate']>
    >['results'],
  ) {
    setUploading(true);
    let cursor = 0;
    const work = async () => {
      for (;;) {
        const result = results[cursor++];
        if (!result) return;
        if (result.status !== 'created' || !result.caseId) continue;
        const index = result.row - 1,
          selected = images[index] ?? [];
        if (!selected.length) {
          setMediaResults((old) => ({
            ...old,
            [index]:
              mode === 'new'
                ? '待補圖片；未正式派件'
                : '歷史建檔完成（無圖，未派件）',
          }));
          continue;
        }
        let failed = false;
        for (const image of selected) {
          if (image.state === 'ready') continue;
          updateImageState(index, image.id, 'uploading');
          try {
            const record = await orpc.cases.detail.call({ id: result.caseId });
            const body = new FormData();
            body.set('files', image.file);
            body.set('expectedVersion', String(record.version));
            body.set('uploadKey', image.id);
            const response = await fetch(
              `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/cases/${encodeURIComponent(result.caseId)}/media`,
              { method: 'POST', credentials: 'include', body },
            );
            if (!response.ok) throw new Error('upload');
            const saved = (await response.json()) as { ids: string[] };
            updateImageState(index, image.id, 'ready', saved.ids[0]);
          } catch {
            failed = true;
            updateImageState(index, image.id, 'failed');
          }
        }
        if (failed) {
          setMediaResults((old) => ({
            ...old,
            [index]: '部分圖片失敗；保留案件，不正式派件，可重試失敗圖片',
          }));
          continue;
        }
        try {
          if (mode === 'new' && formalDispatch && rows[index].collector) {
            const final = await orpc.cases.finalizeBulkMedia.call({
              batchId,
              row: result.row,
              expectedImageCount: selected.length,
            });
            setMediaResults((old) => ({
              ...old,
              [index]: final.warning
                ? `圖片完成，派件警告：${final.warning}`
                : '圖片完成，正式委外已建立',
            }));
          } else
            setMediaResults((old) => ({
              ...old,
              [index]: '圖片完成；未建立 Telegram 派件',
            }));
        } catch {
          setMediaResults((old) => ({
            ...old,
            [index]: '圖片已保存，正式派件未完成；可重試完成此列',
          }));
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: 3 }, work));
      await refresh();
    } finally {
      setUploading(false);
    }
  }
  const [batchId, setBatchId] = useState(() => crypto.randomUUID());
  const [formalDispatch, setFormalDispatch] = useState(false);
  const [paste, setPaste] = useState(''),
    [message, setMessage] = useState('');
  const [previewKey, setPreviewKey] = useState('');
  const canAssign =
    permissions.can('assignment.create') && permissions.can('assignment.bulk');
  const collectors = useQuery({
    ...orpc.collectors.choices.queryOptions(),
    enabled: permissions.can('case.view') && canAssign,
  });
  const preview = useMutation(
    orpc.cases.previewBulkCreate.mutationOptions({
      onError: () => setMessage('無法預覽，請確認權限與資料。'),
    }),
  );
  const create = useMutation(
    orpc.cases.bulkCreate.mutationOptions({
      onSuccess: () => {
        void refresh();
      },
      onError: () =>
        setMessage('建立失敗，請確認權限；重試使用同一批次，不會重複建案。'),
    }),
  );
  if (permissions.isPending) return <p>載入中…</p>;
  if (!permissions.can('case.create')) return <p>無操作權限</p>;
  const input: InputData = {
    batchId,
    mode: mode ?? 'new',
    formalDispatch,
    rows: rows.map((row, index) => ({
      ...row,
      imageCount: images[index]?.length ?? 0,
    })),
  };
  const key = JSON.stringify(input);
  const busy = preview.isPending || create.isPending || uploading;
  const update = (index: number, values: Partial<Row>) =>
    setRows((old) =>
      old.map((row, i) => (i === index ? { ...row, ...values } : row)),
    );
  const reset = () => {
    setRows([emptyRow()]);
    setImages([[]]);
    setMediaResults({});
    setBatchId(crypto.randomUUID());
    setPreviewKey('');
    preview.reset();
    create.reset();
    setPaste('');
    setMessage('');
    setFormalDispatch(false);
  };
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">批量建檔</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          每批最多 20 筆，先預覽並確認，再逐筆建立。單筆失敗不影響其他案件。
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {(['new', 'historical'] as const).map((value) => (
          <button
            type="button"
            key={value}
            disabled={busy}
            aria-label={value === 'new' ? '新案件批量建檔' : '歷史案件批量建檔'}
            aria-pressed={mode === value}
            onClick={() => {
              if (mode !== value) {
                reset();
                setMode(value);
              }
            }}
            className={`rounded-xl border p-5 text-left ${mode === value ? 'border-primary bg-primary/10' : 'bg-card'}`}
          >
            <span className="block text-lg font-medium">
              {value === 'new' ? '新案件批量建檔' : '歷史案件批量建檔'}
            </span>
            <span className="mt-2 block text-sm text-muted-foreground">
              {value === 'new'
                ? '可建立未委外案件，或明確選擇正式派件。'
                : '補登既有案件與歷史委外，絕不發送 Telegram。'}
            </span>
          </button>
        ))}
      </div>
      {mode && (
        <>
          <section className="space-y-3 rounded-xl border bg-card p-4">
            <label htmlFor="bulk-paste" className="block font-medium">
              貼上 Excel／Google Sheet 資料
            </label>
            <p className="text-sm text-muted-foreground">
              欄位順序：代號、客戶姓名、地區、地址、外收人員（代號或完整名稱）。使用定位字元分隔；不需欄位標題。
            </p>
            <Textarea
              id="bulk-paste"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={'T001\t虛構客戶\t桃園市\t虛構地址\t'}
              disabled={busy || !!create.data}
            />
            <Button
              variant="outline"
              disabled={busy || !paste.trim() || !!create.data}
              onClick={() => {
                const parsed = paste
                  .replace(/\r\n?/g, '\n')
                  .split('\n')
                  .filter((line) => line.trim())
                  .map((line) => line.split('\t'));
                if (
                  parsed.length > 20 ||
                  parsed.some((cols) => cols.length > 5)
                ) {
                  setMessage('每批最多 20 筆、每列最多 5 欄；請調整後再解析。');
                  return;
                }
                setRows(
                  parsed.map(
                    ([
                      code = '',
                      customerName = '',
                      region = '',
                      address = '',
                      collector = '',
                    ]) => ({
                      code: code.trim(),
                      customerName: customerName.trim(),
                      region: region.trim(),
                      address: address.trim(),
                      collector: collector.trim(),
                      duplicateOverride: false,
                      imageCount: 0,
                    }),
                  ),
                );
                setImages(parsed.map(() => []));
                setMessage('已解析，請檢查每列資料並預覽。');
              }}
            >
              解析並填入表格
            </Button>
          </section>
          {mode === 'new' && canAssign && (
            <label
              htmlFor="formal-dispatch"
              className="flex items-start gap-3 rounded-xl border bg-card p-4"
            >
              <Checkbox
                id="formal-dispatch"
                checked={formalDispatch}
                disabled={busy || !!create.data}
                onCheckedChange={(value) => setFormalDispatch(value === true)}
              />
              <span>
                正式派件
                <span className="mt-1 block text-sm text-muted-foreground">
                  有指定外收人員的列，會建立正式 assignment 並各自發送
                  Telegram；未指定的列不派件。
                </span>
              </span>
            </label>
          )}
          {mode === 'historical' && (
            <p className="rounded-xl border bg-card p-4 text-sm">
              歷史模式：指定外收人員時建立歷史委外紀錄，Telegram outbound 為
              0。之後重新正式委外才會派件。
            </p>
          )}
          <section aria-label="批量建檔資料" className="space-y-3">
            {rows.map((row, index) => {
              const result = create.data?.results.find(
                (r) => r.row === index + 1,
              );
              const locked = busy || result?.status === 'created';
              const check =
                previewKey === key ? preview.data?.[index] : undefined;
              return (
                <article
                  key={`${batchId}:${index}`}
                  className="space-y-3 rounded-xl border bg-card p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-medium">第 {index + 1} 筆</h2>
                    {!create.data && (
                      <Button
                        variant="ghost"
                        disabled={busy || rows.length === 1}
                        onClick={() => {
                          setRows((old) => old.filter((_, i) => i !== index));
                          setImages((old) => old.filter((_, i) => i !== index));
                        }}
                      >
                        移除這列
                      </Button>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <label
                      htmlFor={`bulk-${index}-code`}
                      className="space-y-1 text-sm"
                    >
                      代號
                      <Input
                        id={`bulk-${index}-code`}
                        aria-label={`第 ${index + 1} 筆代號`}
                        value={row.code}
                        maxLength={60}
                        disabled={locked}
                        onChange={(e) =>
                          update(index, { code: e.target.value })
                        }
                      />
                    </label>
                    <label
                      htmlFor={`bulk-${index}-name`}
                      className="space-y-1 text-sm"
                    >
                      客戶姓名
                      <Input
                        id={`bulk-${index}-name`}
                        aria-label={`第 ${index + 1} 筆姓名`}
                        value={row.customerName}
                        maxLength={120}
                        disabled={locked}
                        onChange={(e) =>
                          update(index, { customerName: e.target.value })
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      地區
                      <select
                        aria-label={`第 ${index + 1} 筆地區`}
                        value={row.region}
                        disabled={locked}
                        onChange={(e) =>
                          update(index, { region: e.target.value })
                        }
                        className="h-9 w-full rounded-md border bg-background px-3"
                      >
                        <option value="">請選擇</option>
                        {REGIONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                        {row.region &&
                          !REGIONS.includes(
                            row.region as (typeof REGIONS)[number],
                          ) && (
                            <option value={row.region}>
                              {row.region}（無效）
                            </option>
                          )}
                      </select>
                    </label>
                    <label
                      htmlFor={`bulk-${index}-address`}
                      className="space-y-1 text-sm"
                    >
                      地址（選填）
                      <Input
                        id={`bulk-${index}-address`}
                        aria-label={`第 ${index + 1} 筆地址`}
                        value={row.address}
                        maxLength={500}
                        disabled={locked}
                        onChange={(e) =>
                          update(index, { address: e.target.value })
                        }
                      />
                    </label>
                    {canAssign && (
                      <label className="space-y-1 text-sm">
                        外收人員（選填）
                        <select
                          aria-label={`第 ${index + 1} 筆外收人員`}
                          value={row.collector}
                          disabled={locked}
                          onChange={(e) =>
                            update(index, { collector: e.target.value })
                          }
                          className="h-9 w-full rounded-md border bg-background px-3"
                        >
                          <option value="">未委外</option>
                          {collectors.data?.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.displayName} · {c.code}
                            </option>
                          ))}
                          {row.collector &&
                            !collectors.data?.some(
                              (c) => c.id === row.collector,
                            ) && (
                              <option value={row.collector}>
                                {row.collector}
                              </option>
                            )}
                        </select>
                      </label>
                    )}
                  </div>
                  {permissions.can('media.upload') && (
                    <BulkRowImages
                      row={index + 1}
                      images={images[index] ?? []}
                      disabled={busy}
                      onChange={(value) =>
                        setImages((old) =>
                          rows.map((_, i) =>
                            i === index ? value : (old[i] ?? []),
                          ),
                        )
                      }
                      onRetry={
                        result ? () => void uploadRows([result]) : undefined
                      }
                      onRemove={
                        result?.caseId && permissions.can('media.delete')
                          ? (image) =>
                              void (async () => {
                                if (!image.mediaId || !result.caseId) return;
                                setUploading(true);
                                try {
                                  const record = await orpc.cases.detail.call({
                                    id: result.caseId,
                                  });
                                  await orpc.cases.deleteMedia.call({
                                    caseId: result.caseId,
                                    mediaId: image.mediaId,
                                    expectedVersion: record.version,
                                  });
                                  setImages((old) =>
                                    old.map((values, i) =>
                                      i === index
                                        ? values.filter(
                                            (value) => value.id !== image.id,
                                          )
                                        : values,
                                    ),
                                  );
                                  await refresh();
                                } catch {
                                  setMessage(
                                    '移除圖片失敗，請重新整理案件確認。',
                                  );
                                } finally {
                                  setUploading(false);
                                }
                              })()
                          : undefined
                      }
                    />
                  )}
                  {mediaResults[index] && (
                    <output className="block text-sm">
                      {mediaResults[index]}
                    </output>
                  )}
                  {result?.status === 'created' && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void uploadRows([result])}
                    >
                      完成此列圖片／派件
                    </Button>
                  )}
                  {check && (
                    <p
                      className={
                        check.status === 'ready'
                          ? 'text-sm text-success'
                          : 'text-sm text-warning'
                      }
                    >
                      {check.status === 'ready'
                        ? '可建立'
                        : check.reasons.join('；')}
                    </p>
                  )}
                  {(check?.status === 'duplicate' || row.duplicateOverride) && (
                    <label
                      htmlFor={`bulk-${index}-override`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={`bulk-${index}-override`}
                        checked={row.duplicateOverride}
                        disabled={locked}
                        onCheckedChange={(value) =>
                          update(index, { duplicateOverride: value === true })
                        }
                      />
                      已人工確認此列為獨立案件，仍要建立
                    </label>
                  )}
                  {result && (
                    <div className="text-sm">
                      <p
                        className={
                          result.status === 'created'
                            ? 'text-success'
                            : 'text-destructive'
                        }
                      >
                        {result.status === 'created'
                          ? '建立成功'
                          : result.reason}
                      </p>
                      {result.warning && (
                        <p className="text-warning">
                          案件與委外已保留；派件警告：{result.warning}
                        </p>
                      )}
                      {result.caseId && (
                        <Link
                          to="/cases/$caseId"
                          params={{ caseId: result.caseId }}
                          className="text-primary"
                        >
                          查看案件
                        </Link>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </section>
          {message && <output className="block text-sm">{message}</output>}
          {create.data && (
            <output className="block rounded-xl border bg-card p-4">
              成功：{create.data.succeeded} · 失敗：{create.data.failed}
              ；每列結果顯示於上方。
            </output>
          )}
          <div className="flex flex-wrap gap-3">
            {!create.data && (
              <Button
                variant="outline"
                disabled={busy || rows.length >= 20}
                onClick={() => {
                  setRows((old) => [...old, emptyRow()]);
                  setImages((old) => [...old, []]);
                }}
              >
                新增一列
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                await preview
                  .mutateAsync(input)
                  .then(() => setPreviewKey(key))
                  .catch(() => {});
              }}
            >
              預覽並驗證
            </Button>
            <Button
              disabled={
                busy ||
                previewKey !== key ||
                !preview.data?.some((r) => r.status === 'ready')
              }
              onClick={async () => {
                try {
                  const result = await create.mutateAsync(input);
                  await uploadRows(result.results);
                } catch {}
              }}
            >
              {create.isPending ? '逐筆建立中…' : '確認批量建立'}
            </Button>
            {create.data && (
              <Button variant="outline" disabled={busy} onClick={reset}>
                開始下一批
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
