/** Display labels only: API and database values remain unchanged. */
const labels: Record<string, string> = {
  BOT_DISABLED: '機器人已停用，委外保留且未傳送',
  pending: '待處理',
  assigned: '已委外',
  unassigned: '未委外',
  follow_up: '安排二訪',
  installment: '分期',
  settled: '結清',
  direct_to_principal: '後結',
  unresolved: '無解',
  needs_review: '待確認',
  cannot_find: '找不到客戶',
  recommended: '值得二訪',
  observe: '可再觀察',
  not_recommended: '不建議二訪',
  not_needed: '不需二訪',
  not_required: '不需二訪',
  deadline: '指定日期前處理',
  weekly: '每週',
  monthly: '每月',
  custom: '自訂分期',
  active: '進行中',
  cancelled: '已取消',
  completed: '已完成',
  paid: '已付款',
  partial: '部分付款',
  overdue: '逾期',
  received: '已接收',
  processing: '處理中',
  matched: '已配對',
  created: '已建案',
  rejected: '已拒絕',
  failed: '失敗',
  approved: '已核准',
  corrected: '修改後核准',
  manual: '人工',
  telegram: 'Telegram',
  line: 'LINE',
  poster_builder: '製圖小幫手',
  historical_import: '歷史匯入',
  api: 'API 接收',
  ai: 'AI',
  admin: '管理員',
  collector_portal: '外收人員入口',
  sending: '傳送中',
  sent: '已傳送',
  skipped: '已略過',
  retrying: '待重試',
  queued: '佇列中',
  awaiting_status: '等待狀態確認',
  unique_match: '唯一配對',
  ambiguous: '多筆候選，需確認',
  no_match: '未找到配對',
  case_no: '案件編號',
  code: '代號',
  customer_name: '客戶姓名',
  address: '地址',
  amount_due: '應收款項',
  customerName: '客戶姓名',
  amountDue: '應收款項',
  revisit_status: '二訪建議',
  revisit_reason: '二訪原因',
  payment_detected: '收款標記',
  payment_amount: '收款金額',
  confidence: '信心值',
  status: '狀態',
  intake_source: '收件來源',
  collector: '外收人員',
  report_destination: '業務回報群組',
  assignment: '派單',
  assignment_dispatch: '案件派單',
  collector_prompt: '外收人員狀態確認',
  report: '回報',
  report_forward: '轉發回報',
  case_assignment: '案件派單',
  exact: '完全符合',
  normalized_address: '地址比對',
  none: '無',
  name: '姓名',
  name_address: '姓名與地址',
  customer_name_address: '姓名與地址',
  live: '連線模式',
  mock: '模擬模式',
  disabled: '已停用',
  local: '本機模式',
  high: '高',
  normal: '一般',
  low: '低',
  urgent: '緊急',
  selected_case: '確認案件',
};
export function displayLabel(value: string): string {
  return labels[value] ?? value;
}
export function installmentStatusLabel(value: string): string {
  return value === 'pending' ? '待付款' : displayLabel(value);
}
export function displayFieldValue(key: string, value: unknown): string {
  if (value === null) return '未提供';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string' && ['status', 'revisit_status'].includes(key)) {
    return displayLabel(value);
  }
  return String(value);
}
export function displayMessage(value: string): string {
  const messages: Record<string, string> = {
    'Case identity or address requires a human choice.':
      '案件身分或地址需要人工確認配對。',
    'Incomplete or uncertain extraction requires confirmation.':
      '辨識資料不完整或不確定，需要人工確認。',
    'Report requires manual classification before updating the case.':
      '更新案件前，需要人工確認回報分類。',
  };
  return messages[value] ?? value;
}
/** Translate provider/API errors at the presentation boundary. */
export function displayError(
  error: unknown,
  fallback = '操作失敗，請稍後重試。',
): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  if (['FORBIDDEN', 'PERMISSION_DENIED', 'UNAUTHORIZED'].includes(code))
    return '無操作權限，請確認已登入。';
  if (code === 'NOT_FOUND') return '找不到資料。';
  if (code === 'CONFLICT') return '資料已變更，請重新整理後重試。';
  const message = error instanceof Error ? error.message : '';
  return /[\u3400-\u9fff]/.test(message) ? message : fallback;
}
