import { useQuery } from '@tanstack/react-query';
import { orpc } from '~/lib/orpc';
import { useCasePermissions } from './management-hooks';
import { CaseError, LoadingCases, timestamp } from './presentation';

const actionLabels: Record<string, string> = {
  bulk_assignment_created: '已建立批量派單',
  'manual.case_created': '已建立案件',
  'manual.image_uploaded': '已上傳委外圖片',
  duplicate_warning_overridden: '已確認重複建案提醒並繼續',
  'case.region_changed': '已更正地區',
  'case.customer_code_corrected': '已更正客戶或代號',
  'assignment.corrected': '已更正歷史外收人員',
  'installment.plan_created': '已建立分期計畫',
  'installment.plan_cancelled': '已取消分期計畫',
  'installment.workflow_started': '已開始設定分期',
  'installment.workflow_advanced': '已更新分期設定',
  'installment.workflow_cancelled': '已取消分期設定',
  'payment.received': '已收款',
  'payment.voided': '已作廢收款',
  'settlement.created': '已建立回款紀錄',
  'settlement.marked_returned': '已標記回款',
  'settlement.marked_pending': '已標記尚未回款',
  'review.created': '已建立人工確認',
  'review.approved': '已核准人工確認',
  'review.corrected': '已修改後核准',
  'review.rejected': '已拒絕人工確認',
  'report.created': '已建立回報',
  'report.edited': '已編輯回報',
  'case.created': '已建立案件',
  'case.edited': '已編輯案件',
  'assignment.created': '已指派案件',
  'assignment.reassigned': '已改派案件',
  'assignment.unassigned': '已解除指派',
  'media.uploaded': '已上傳圖片',
  'media.reordered': '已調整圖片排序',
  'media.deleted': '已刪除圖片',
};

export function AuditTimeline({ caseId }: { caseId: string }) {
  const permissions = useCasePermissions();
  const options = orpc.cases.audit.queryOptions({ input: { id: caseId } });
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('audit_log.view'),
  });
  if (!permissions.can('audit_log.view'))
    return (
      <p className="text-sm text-muted-foreground">無操作紀錄查看權限。</p>
    );
  if (result.isPending) return <LoadingCases />;
  if (result.isError) return <CaseError retry={() => void result.refetch()} />;
  if (!result.data.length)
    return (
      <p className="rounded-xl bg-muted/50 p-8 text-sm text-muted-foreground">
        暫無操作紀錄。
      </p>
    );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        最近 100 筆操作 · 詳細資料僅包含欄位名稱與識別碼。
      </p>
      <ol className="space-y-4 border-l border-border pl-5">
        {result.data.map((item) => (
          <li
            key={item.id}
            className="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
          >
            <p className="text-base font-medium">
              {actionLabels[item.action] ?? item.action}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {item.actor ?? '已移除的使用者'} · {timestamp(item.createdAt)}
            </p>
            <details className="mt-3 text-sm text-muted-foreground">
              <summary className="cursor-pointer">操作詳細資料</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs">
                {item.metadata}
              </pre>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
