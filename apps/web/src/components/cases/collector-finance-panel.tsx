import { financePeriod } from '@saasflare-dev/api/business-dates';
import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { orpc } from '~/lib/orpc';
import { displayError } from './display-labels';
import { useCasePermissions } from './management-hooks';
import { money } from './presentation';

export function CollectorFinancePanel() {
  const permissions = useCasePermissions(),
    qc = useQueryClient();
  const [collectorId, setCollector] = useState(''),
    [status, setStatus] = useState<'all' | 'pending' | 'returned'>('all'),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1);
  const [dateFrom, setFrom] = useState(''),
    [dateTo, setTo] = useState(''),
    [period, setPeriod] = useState('custom');
  const [amount, setAmount] = useState(''),
    [date, setDate] = useState(''),
    [note, setNote] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [exporting, setExporting] = useState(false);
  const [voiding, setVoiding] = useState<{
      id: string;
      type: 'offset' | 'remittance';
    } | null>(null),
    [reason, setReason] = useState('');
  const input = {
    collectorId: collectorId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    query,
    status,
    page,
    pageSize: 25,
  };
  const options = orpc.collectorFinance.report.queryOptions({ input });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    retry: false,
    refetchInterval: 30000,
  });
  const collectors = useQuery(orpc.collectorFinance.collectors.queryOptions());
  const clock = useQuery(
    orpc.clearing.overview.queryOptions({
      input: { collectorId: collectorId || undefined },
    }),
  );
  const create = useMutation(
      orpc.collectorFinance.createRemittance.mutationOptions(),
    ),
    voidRemit = useMutation(
      orpc.collectorFinance.voidRemittance.mutationOptions(),
    ),
    voidOffset = useMutation(
      orpc.collectorFinance.voidOffset.mutationOptions(),
    );
  const all = permissions.can('case.view_all'),
    busy = create.isPending || voidRemit.isPending || voidOffset.isPending;
  const selected = collectorId || result.data?.collectorId || '';
  async function act(operation: () => Promise<unknown>, message: string) {
    setError('');
    setNotice('');
    try {
      await operation();
      await qc.invalidateQueries();
      setNotice(message);
    } catch (e) {
      setError(displayError(e, '財務操作失敗，請重試。'));
    }
  }
  async function exportLedger() {
    setExporting(true);
    setError('');
    try {
      const output = await orpc.collectorFinance.export.call({
        ...input,
        page: 1,
      });
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(output.bytes).buffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = output.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(displayError(e, '匯出失敗。'));
    } finally {
      setExporting(false);
    }
  }
  return (
    <section
      aria-label={all ? '外收結算財報' : '我的財務'}
      className="min-w-0 space-y-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">外收結算財報</h1>
        {permissions.can('finance.export') && (
          <Button
            variant="outline"
            disabled={exporting}
            onClick={() => void exportLedger()}
          >
            匯出外收結算明細
          </Button>
        )}
      </header>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="ledger-collector">外收人員</Label>
          <select
            id="ledger-collector"
            className="mt-2 h-10 w-full rounded-md border bg-background px-3"
            value={collectorId}
            onChange={(e) => {
              setCollector(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{all ? '全部' : '我的帳務'}</option>
            {collectors.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="ledger-status">回帳狀態</Label>
          <select
            id="ledger-status"
            className="mt-2 h-10 w-full rounded-md border bg-background px-3"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setPage(1);
            }}
          >
            <option value="all">全部</option>
            <option value="pending">尚未回帳</option>
            <option value="returned">已回帳</option>
          </select>
        </div>
        <div>
          <Label htmlFor="ledger-query">關鍵字</Label>
          <Input
            id="ledger-query"
            placeholder="代號／客戶姓名"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>
      <section className="flex flex-wrap gap-2" aria-label="快速日期選擇">
        {(['today', 'month', 'previous', 'custom'] as const).map(
          (value, index) => (
            <Button
              key={value}
              variant={period === value ? 'default' : 'outline'}
              aria-pressed={period === value}
              disabled={!clock.data?.businessDate}
              onClick={() => {
                setPeriod(value);
                setPage(1);
                if (value !== 'custom') {
                  const range = financePeriod(value, clock.data?.businessDate);
                  setFrom(range.dateFrom);
                  setTo(range.dateTo);
                }
              }}
            >
              {['今天', '本月', '上個月', '自訂'][index]}
            </Button>
          ),
        )}
        <output className="w-full text-sm text-muted-foreground">
          目前期間：{dateFrom || '不限'} ～ {dateTo || '不限'}
        </output>
      </section>
      {period === 'custom' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="financeFrom">開始日期</Label>
            <Input
              id="financeFrom"
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div>
            <Label htmlFor="financeTo">結束日期</Label>
            <Input
              id="financeTo"
              type="date"
              value={dateTo}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <output className="block">{notice}</output>}
      {permissions.can('settlement.mark_returned') && (
        <form
          className="space-y-3 border-y py-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selected) {
              setError('請先選擇外收人員。');
              return;
            }
            void act(async () => {
              await create.mutateAsync({
                collectorId: selected,
                idempotencyKey: key,
                amount: Number(amount),
                receivedDate: date,
                note,
              });
              setKey(crypto.randomUUID());
              setAmount('');
              setNote('');
            }, '回帳已建立。');
          }}
        >
          <h2 className="font-medium">新增回帳</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="remit-amount">回帳金額</Label>
              <Input
                id="remit-amount"
                type="number"
                min="1"
                step="1"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="remit-date">回帳日期</Label>
              <Input
                id="remit-date"
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="remit-note">備註</Label>
              <Input
                id="remit-note"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
          <Button disabled={busy || !selected}>新增回帳</Button>
        </form>
      )}
      {result.isPending ? (
        <p>載入中…</p>
      ) : result.isError ? (
        <p role="alert">財報載入失敗，請重試。</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border sm:block">
            <table className="w-full text-sm" aria-label="外收財務流水">
              <thead className="bg-muted/40">
                <tr>
                  {['日期', '代號', '姓名', '實際收款', '應回帳', '已回帳'].map(
                    (label) => (
                      <th
                        key={label}
                        className="px-3 py-3 text-left font-medium"
                      >
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((row) => (
                  <tr key={row.type + row.id} className="border-t">
                    <td className="px-3 py-2" title={row.received_date}>
                      {row.received_date.slice(5).replace('-', '/')}
                    </td>
                    <td className="px-3 py-2">
                      {row.case_id ? (
                        <Link
                          to="/cases/$caseId"
                          params={{ caseId: row.case_id }}
                        >
                          {row.code}
                        </Link>
                      ) : (
                        row.code
                      )}
                    </td>
                    <td className="px-3 py-2">{row.customer_name}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {money(row.actual_received)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {money(row.return_due)}
                    </td>
                    <td className="px-3 py-2">
                      {row.type === 'payment'
                        ? money(row.returned_amount)
                        : row.marker}
                      {permissions.can('settlement.mark_pending') &&
                        row.type !== 'payment' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setVoiding({
                                id: row.id,
                                type: row.type as 'offset' | 'remittance',
                              });
                              setReason('');
                            }}
                          >
                            作廢
                          </Button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section
            className="space-y-2 sm:hidden"
            aria-label="外收財務流水手機版"
          >
            {result.data.items.map((row) => (
              <article
                key={row.type + row.id}
                className="rounded-lg border p-3 text-sm"
              >
                <div className="flex justify-between gap-2">
                  <span title={row.received_date}>
                    {row.received_date.slice(5).replace('-', '/')}
                  </span>
                  <span>
                    {row.code} · {row.customer_name}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-2">
                  {[
                    ['實際收款', money(row.actual_received)],
                    ['應回帳', money(row.return_due)],
                    [
                      '已回帳',
                      row.type === 'payment'
                        ? money(row.returned_amount)
                        : row.marker,
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
                {row.type !== 'payment' &&
                  permissions.can('settlement.mark_pending') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setVoiding({
                          id: row.id,
                          type: row.type as 'offset' | 'remittance',
                        });
                        setReason('');
                      }}
                    >
                      作廢
                    </Button>
                  )}
              </article>
            ))}
          </section>
          {!result.data.items.length && (
            <p className="py-8 text-center text-muted-foreground">暫無資料</p>
          )}
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>
              共 {result.data.total} 筆 · 第 {page} 頁
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                上一頁
              </Button>
              <Button
                variant="outline"
                disabled={page * 25 >= result.data.total}
                onClick={() => setPage(page + 1)}
              >
                下一頁
              </Button>
            </div>
          </div>
          <dl className="space-y-2 border-t pt-4 text-sm" aria-label="財報總結">
            {[
              ['總實際收款', result.data.summary.actualReceived],
              ['總應回帳', result.data.summary.returnDue],
              ['總後結金額', result.data.summary.offset],
              ['總回帳金額', result.data.summary.remitted],
              ['實際應回款', result.data.summary.netReturnDue],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt>{label}</dt>
                <dd className="font-medium tabular-nums">
                  {money(Number(value))}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            總結依目前篩選期間的有效流水計算；負數表示此外收預繳或後結抵扣餘額。全部外收僅合計展示，不會跨外收分配回帳。
          </p>
        </>
      )}
      {voiding && (
        <form
          role="alertdialog"
          aria-label="確認作廢財務事件"
          className="space-y-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await (voiding.type === 'remittance'
                ? voidRemit
                : voidOffset
              ).mutateAsync({ id: voiding.id, reason });
              setVoiding(null);
            }, '已作廢，歷史紀錄保留。');
          }}
        >
          <p>
            確定作廢這筆{voiding.type === 'remittance' ? '回帳' : '後結'}嗎？
          </p>
          <Label htmlFor="void-reason">作廢原因</Label>
          <Input
            id="void-reason"
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setVoiding(null)}
            >
              取消
            </Button>
            <Button disabled={busy}>確認作廢</Button>
          </div>
        </form>
      )}
    </section>
  );
}
