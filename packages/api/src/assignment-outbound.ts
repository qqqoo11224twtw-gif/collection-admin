import { renderAssignment } from './bulk-assignment';
import type { Context } from './context';
import { systemLog } from './system-log';
import { outboundPayloadSchema } from './telegram-contract';
export async function queueAssignmentDispatch(
  context: Context,
  assignmentId: string,
) {
  const assignment = await context.env.DB.prepare(
    "SELECT a.id,a.collector_id,a.case_id,c.case_no,c.code,c.customer_name,c.address,c.amount_due,c.region FROM assignments a JOIN cases c ON c.id=a.case_id JOIN collectors co ON co.id=a.collector_id WHERE a.id=? AND a.unassigned_at IS NULL AND a.record_type='assignment' AND c.voided_at IS NULL AND co.is_active=1",
  )
    .bind(assignmentId)
    .first<{
      id: string;
      collector_id: string;
      case_id: string;
      case_no: string;
      code: string;
      customer_name: string;
      address: string;
      amount_due: number;
      region: string | null;
    }>();
  if (!assignment) return;
  const routes = await context.env.DB.prepare(
    "SELECT id,chat_id,topic_id FROM telegram_routes WHERE collector_id=? AND is_active=1 AND route_type IN ('collector_dispatch','collector') LIMIT 2",
  )
    .bind(assignment.collector_id)
    .all<{ id: string; chat_id: string; topic_id: number | null }>();
  if (routes.results.length !== 1) {
    await systemLog(context.env.DB, {
      category: 'outbound',
      event: 'ROUTE_NOT_FOUND',
      level: 'warning',
      status: 'failed',
      errorCode: 'ROUTE_NOT_FOUND',
      relatedCaseId: assignment.case_id,
      relatedCollectorId: assignment.collector_id,
    });
    return { queued: false, warning: 'ROUTE_NOT_FOUND' as const };
  }
  const route = routes.results[0],
    id = crypto.randomUUID(),
    now = Date.now();
  const payload = outboundPayloadSchema.parse({
    chatId: route.chat_id,
    topicId: route.topic_id,
    text: renderAssignment({
      caseNo: assignment.case_no,
      code: assignment.code,
      customerName: assignment.customer_name,
      address: assignment.address,
      amountDue: assignment.amount_due,
      region: assignment.region,
    }),
  });
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO telegram_outbound_jobs(id,dedupe_key,message_type,assignment_id,route_id,payload,status,attempts,next_attempt_at,created_at) SELECT ?,?,'assignment_dispatch',?,?,?,'pending',0,?,? WHERE EXISTS(SELECT 1 FROM assignments a JOIN telegram_routes r ON r.id=? WHERE a.id=? AND a.unassigned_at IS NULL AND r.is_active=1 AND r.collector_id=a.collector_id) ON CONFLICT DO NOTHING",
    ).bind(
      id,
      `assignment-dispatch:${assignmentId}`,
      assignmentId,
      route.id,
      JSON.stringify(payload),
      now,
      now,
      route.id,
      assignmentId,
    ),
    context.env.DB.prepare(
      "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'assignment.outbound_queued','telegram',?,?,? WHERE changes()=1",
    ).bind(
      crypto.randomUUID(),
      context.user?.id ?? null,
      id,
      JSON.stringify({
        assignmentId,
        caseId: assignment.case_id,
        routeId: route.id,
      }),
      now,
    ),
  ]);
  return { queued: true, warning: null };
}
