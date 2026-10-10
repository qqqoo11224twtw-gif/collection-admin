import { Button } from '@saasflare-dev/ui/components/button';
import { Input } from '@saasflare-dev/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useCasePermissions } from '~/components/cases/management-hooks';
import { orpc } from '~/lib/orpc';
export const Route = createFileRoute('/cases/system-logs')({
  component: LogsPage,
});
const categories = {
  telegram: 'Telegram',
  intake: '收件',
  outbound: '派單',
  openai: 'OpenAI',
  storage: 'R2',
  otp: '驗證碼',
  auth: '登入',
  permission: '權限',
  finance: '財務',
  installment: '分期',
  database: '資料庫',
  scheduler: '排程',
  system: '系統',
} as const;
function LogsPage() {
  const permissions = useCasePermissions(),
    qc = useQueryClient();
  const [filters, setFilters] = useState({
    query: '',
    level: '' as '' | 'info' | 'warning' | 'error' | 'critical',
    category: '' as '' | keyof typeof categories,
    status: '' as '' | 'pending' | 'acknowledged' | 'resolved',
    eventStatus: '' as '' | 'success' | 'failed' | 'retry' | 'denied',
    page: 1,
    dateFrom: '',
    dateTo: '',
  });
  const list = useQuery({
    ...orpc.systemLogs.list.queryOptions({
      input: {
        ...filters,
        dateFrom: filters.dateFrom || undefined,
        dateTo: filters.dateTo || undefined,
      },
    }),
    enabled: permissions.can('system_log.view'),
  });
  const summary = useQuery({
    ...orpc.systemLogs.summary.queryOptions(),
    enabled: permissions.can('system_log.view'),
  });
  const handle = useMutation(
    orpc.systemLogs.handle.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries();
      },
    }),
  );
  const [selected, setSelected] = useState<string | null>(null),
    [note, setNote] = useState('');
  if (permissions.isPending) return <p>載入中…</p>;
  if (!permissions.can('system_log.view')) return <p>無操作權限</p>;
  const row = list.data?.items.find((r) => r.id === selected);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">系統管理日誌</h1>
      <p className="text-sm text-muted-foreground">
        系統事件與操作紀錄分開保存。日誌僅顯示安全診斷資訊。
      </p>
      <div className="flex flex-wrap gap-3">
        {Object.entries({
          今日錯誤: summary.data?.errors ?? 0,
          'Telegram 失敗': summary.data?.telegramFailures ?? 0,
          待重試: summary.data?.pendingRetry ?? 0,
          'OpenAI 失敗': summary.data?.openaiFailures ?? 0,
          驗證碼失敗: summary.data?.otpFailures ?? 0,
          拒絕登入: summary.data?.deniedLogins ?? 0,
        }).map(([label, total]) => (
          <div key={label} className="rounded-lg bg-muted px-4 py-3 text-sm">
            {label}：{total}
          </div>
        ))}
      </div>
      {!!summary.data?.recentErrors.length && (
        <div className="space-y-2 text-sm text-muted-foreground">
          {summary.data.recentErrors.map((log) => (
            <p key={log.id}>
              {new Date(log.timestamp).toLocaleTimeString('zh-TW')} ·{' '}
              {log.safe_message}
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {[
          ['', '全部'],
          ['error', '錯誤'],
          ['warning', '警告'],
          ['telegram', 'Telegram'],
          ['openai', 'OpenAI'],
          ['storage', 'R2'],
          ['otp', '驗證碼'],
          ['auth', '登入'],
          ['permission', '權限'],
        ].map(([key, label]) => (
          <Button
            variant="outline"
            key={key}
            onClick={() =>
              setFilters({
                ...filters,
                page: 1,
                level: key === 'error' || key === 'warning' ? key : '',
                category:
                  key in categories ? (key as keyof typeof categories) : '',
              })
            }
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          aria-label="搜尋日誌"
          placeholder="錯誤代碼、案件、外收、工作或使用者"
          value={filters.query}
          onChange={(e) =>
            setFilters({ ...filters, query: e.target.value, page: 1 })
          }
        />
        <select
          aria-label="日誌類型"
          className="h-9 rounded-lg border bg-background px-3"
          value={filters.category}
          onChange={(e) =>
            setFilters({
              ...filters,
              category: e.target.value as keyof typeof categories | '',
              page: 1,
            })
          }
        >
          <option value="">全部類型</option>
          {Object.entries(categories).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="處理狀態"
          className="h-9 rounded-lg border bg-background px-3"
          value={filters.status}
          onChange={(e) =>
            setFilters({
              ...filters,
              status: e.target.value as
                | ''
                | 'pending'
                | 'acknowledged'
                | 'resolved',
              page: 1,
            })
          }
        >
          <option value="">全部狀態</option>
          <option value="pending">未處理</option>
          <option value="acknowledged">已確認</option>
          <option value="resolved">已處理</option>
        </select>
        <select
          aria-label="事件狀態"
          className="h-9 rounded-lg border bg-background px-3"
          value={filters.eventStatus}
          onChange={(e) =>
            setFilters({
              ...filters,
              eventStatus: e.target.value as typeof filters.eventStatus,
              page: 1,
            })
          }
        >
          <option value="">全部事件狀態</option>
          <option value="success">成功</option>
          <option value="failed">失敗</option>
          <option value="retry">待重試</option>
          <option value="denied">拒絕</option>
        </select>
        <select
          aria-label="日誌等級"
          className="h-9 rounded-lg border bg-background px-3"
          value={filters.level}
          onChange={(e) =>
            setFilters({
              ...filters,
              level: e.target.value as typeof filters.level,
              page: 1,
            })
          }
        >
          <option value="">全部等級</option>
          {Object.entries({
            info: '資訊',
            warning: '警告',
            error: '錯誤',
            critical: '嚴重',
          }).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <Input
          aria-label="開始日期"
          type="date"
          value={filters.dateFrom}
          onChange={(e) =>
            setFilters({ ...filters, dateFrom: e.target.value, page: 1 })
          }
        />
        <Input
          aria-label="結束日期"
          type="date"
          value={filters.dateTo}
          onChange={(e) =>
            setFilters({ ...filters, dateTo: e.target.value, page: 1 })
          }
        />
      </div>
      {list.isPending ? (
        <p>載入中…</p>
      ) : list.isError ? (
        <p role="alert">日誌載入失敗</p>
      ) : !list.data?.items.length ? (
        <p>暫無資料</p>
      ) : (
        <div className="grid gap-3">
          {list.data.items.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                setSelected(r.id);
                setNote(r.note ?? '');
              }}
              className="space-y-1 rounded-xl border bg-card p-4 text-left"
            >
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span>
                  {categories[r.category as keyof typeof categories] ??
                    r.category}{' '}
                  · {r.error_code ?? r.event}
                </span>
                <span>{new Date(r.timestamp).toLocaleString('zh-TW')}</span>
              </div>
              <p className="text-sm text-muted-foreground">{r.safe_message}</p>
              <p className="text-sm">
                {r.code ?? r.collector_name ?? ''} ·{' '}
                {
                  {
                    pending: '未處理',
                    acknowledged: '已確認',
                    resolved: '已處理',
                  }[r.handled_status]
                }
              </p>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          disabled={filters.page <= 1}
          onClick={() => setFilters({ ...filters, page: filters.page - 1 })}
        >
          上一頁
        </Button>
        <span className="text-sm">
          第 {filters.page} 頁 · 共 {list.data?.total ?? 0} 筆
        </span>
        <Button
          variant="outline"
          disabled={filters.page * 25 >= (list.data?.total ?? 0)}
          onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
        >
          下一頁
        </Button>
      </div>
      {row && (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <h2 className="text-lg font-medium">日誌詳情</h2>
          <p className="text-sm">{row.safe_message}</p>
          <dl className="grid gap-2 break-all text-sm sm:grid-cols-2">
            {Object.entries({
              時間: new Date(row.timestamp).toLocaleString('zh-TW'),
              類型: categories[row.category as keyof typeof categories],
              狀態:
                (
                  {
                    success: '成功',
                    failed: '失敗',
                    retry: '待重試',
                    denied: '拒絕',
                  } as Record<string, string>
                )[row.status] ?? row.status,
              等級:
                (
                  {
                    info: '資訊',
                    warning: '警告',
                    error: '錯誤',
                    critical: '嚴重',
                  } as Record<string, string>
                )[row.level] ?? row.level,
              案件: row.case_no,
              外收: row.collector_name,
              路由: row.route_name,
              工作: row.related_job_id,
              使用者: row.user_name,
              請求: row.correlation_id,
              重試: row.retry_count,
              '耗時（毫秒）': row.duration_ms,
              錯誤: row.error_code,
              辨識模型: row.ai_model,
              處理人: row.handled_user_name,
              處理時間: row.handled_at
                ? new Date(row.handled_at).toLocaleString('zh-TW')
                : null,
            }).map(([key, value]) => (
              <div key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd>{value ?? '—'}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-3">
            {row.related_case_id && (
              <Link
                to="/cases/$caseId"
                params={{ caseId: row.related_case_id }}
              >
                查看案件
              </Link>
            )}
            {row.related_collector_id && (
              <Link to="/cases/collectors">查看外收人員</Link>
            )}
            {row.related_route_id && (
              <Link to="/cases/telegram">查看群組設定</Link>
            )}

            {row.review_item_id && permissions.can('review.view') && (
              <Link
                to="/cases/reviews/$reviewId"
                params={{ reviewId: row.review_item_id }}
              >
                查看待確認
              </Link>
            )}
            {row.related_user_id &&
              permissions.can('user_permission.manage') && (
                <Link to="/cases/users">查看使用者權限</Link>
              )}
          </div>
          {permissions.can('system_log.manage') && (
            <>
              <Input
                aria-label="處理備註"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                {Object.entries({
                  pending: '未處理',
                  acknowledged: '已確認',
                  resolved: '已處理',
                }).map(([status, label]) => (
                  <Button
                    key={status}
                    disabled={handle.isPending}
                    onClick={() =>
                      handle.mutate({
                        id: row.id,
                        status: status as
                          | 'pending'
                          | 'acknowledged'
                          | 'resolved',
                        note,
                      })
                    }
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {handle.isError && <p role="alert">處理失敗</p>}
            </>
          )}
          <Button variant="outline" onClick={() => setSelected(null)}>
            關閉
          </Button>
        </div>
      )}
    </div>
  );
}
