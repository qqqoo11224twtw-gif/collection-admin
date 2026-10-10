import type { Context } from './context';

export function normalizeReportName(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

// Case edit/review writes invalidate names atomically. The nullable indexed cache keeps
// exact JS Unicode normalization without transforming/scanning cases per lookup.
// Deployment backfills once; normal requests refresh only newly changed rows.
export async function refreshReportNames(context: Context) {
  for (;;) {
    const dirty = await context.env.DB.prepare(
      'SELECT id,customer_name FROM cases WHERE report_name IS NULL LIMIT 200',
    ).all<{ id: string; customer_name: string }>();
    if (!dirty.results.length) return;
    await context.env.DB.batch(
      dirty.results.map((row) =>
        context.env.DB.prepare(
          'UPDATE cases SET report_name=? WHERE id=? AND customer_name=? AND report_name IS NULL',
        ).bind(
          normalizeReportName(row.customer_name),
          row.id,
          row.customer_name,
        ),
      ),
    );
  }
}
